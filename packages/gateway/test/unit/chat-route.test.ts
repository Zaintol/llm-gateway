import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { chatRoutes, type CredentialSource } from '../../src/chat/route.js';
import { ExecutionEngine } from '../../src/execution/engine.js';
import { ProviderError } from '../../src/providers/errors.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { FakeAdapter, StaticCredentials, cannedResult, fakeAuth } from '../support/fakes.js';

let app: FastifyInstance;
afterEach(() => app?.close());

function make(
  options: { adapter?: FakeAdapter; credentials?: CredentialSource; bodyLimitBytes?: number } = {},
) {
  const adapter = options.adapter ?? new FakeAdapter('mock', (req) => cannedResult(req.model));
  const fakes = fakeAuth();
  const { key } = fakes.store.add();
  app = buildApp({
    logLevel: 'silent',
    readinessChecks: {},
    readinessTimeoutMs: 50,
    auth: fakes.auth,
    ...(options.bodyLimitBytes ? { bodyLimitBytes: options.bodyLimitBytes } : {}),
    dataPlaneRoutes: [
      chatRoutes({
        providers: new ProviderRegistry([adapter]),
        credentials: options.credentials ?? new StaticCredentials(),
        engine: new ExecutionEngine({ sleep: async () => {} }),
      }),
    ],
  });
  const send = (payload: unknown) =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: payload as object,
    });
  return { adapter, send, key };
}

const valid = { model: 'mock/fast', messages: [{ role: 'user', content: 'hi' }] };

describe('POST /v1/chat/completions', () => {
  it('returns the provider response with gateway headers', async () => {
    const { send } = make();
    const res = await send(valid);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      object: 'chat.completion',
      model: 'mock/fast',
      usage: { total_tokens: 4 },
    });
    expect(res.headers).toMatchObject({
      'x-request-id': expect.stringMatching(/^req_/),
      'x-gateway-provider': 'mock',
      'x-gateway-model': 'mock/fast',
      'x-gateway-attempts': '1',
    });
  });

  it('returns 400 invalid_request naming the messages field when it is missing', async () => {
    const { send, adapter } = make();
    const res = await send({ model: 'mock/fast' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      type: 'invalid_request',
      message: expect.stringMatching(/^messages: /),
    });
    expect(adapter.calls).toHaveLength(0);
  });

  it('returns 413 for a body over the limit without calling a provider', async () => {
    const { send, adapter } = make({ bodyLimitBytes: 1024 });
    const res = await send({ ...valid, messages: [{ role: 'user', content: 'x'.repeat(2048) }] });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatchObject({ type: 'invalid_request', code: 'request_too_large' });
    expect(adapter.calls).toHaveLength(0);
  });

  it('returns 400 invalid_json for a malformed body', async () => {
    const { adapter, key } = make();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: '{bad',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ type: 'invalid_request', code: 'invalid_json' });
    expect(adapter.calls).toHaveLength(0);
  });

  it('authenticates before parsing the body', async () => {
    const { adapter } = make();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer not-a-key', 'content-type': 'application/json' },
      payload: '{bad',
    });
    expect(res.statusCode).toBe(401);
    expect(adapter.calls).toHaveLength(0);
  });

  it('accepts unknown top-level fields and does not pass them to the adapter', async () => {
    const { send, adapter } = make();
    const res = await send({ ...valid, logit_bias: { 50256: -100 }, frobnicate: true });
    expect(res.statusCode).toBe(200);
    expect(adapter.calls[0]!.request).toEqual(valid);
  });

  it('returns 400 no_eligible_model for an unknown provider', async () => {
    const { send } = make();
    const res = await send({ ...valid, model: 'nope/model' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ type: 'no_eligible_model', code: 'model_not_found' });
  });

  it('returns 400 no_eligible_model when the provider needs a credential the tenant lacks', async () => {
    const adapter = new FakeAdapter('openai', (req) => cannedResult(req.model), true);
    const { send } = make({ adapter });
    const res = await send({ ...valid, model: 'openai/gpt-4o-mini' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('provider_not_configured');
    expect(adapter.calls).toHaveLength(0);
  });

  it('passes the resolved credential to the adapter', async () => {
    const adapter = new FakeAdapter('openai', (req) => cannedResult(req.model), true);
    const credential = { secret: 'sk-x', baseUrl: null, scope: 'platform' as const };
    const { send } = make({ adapter, credentials: new StaticCredentials({ openai: credential }) });
    expect((await send({ ...valid, model: 'openai/gpt-4o-mini' })).statusCode).toBe(200);
    expect(adapter.calls[0]!.call).toMatchObject({ upstreamModel: 'gpt-4o-mini', credential });
  });

  it('streams when stream: true is set', async () => {
    const { send } = make();
    const res = await send({ ...valid, stream: true });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['x-request-id']).toMatch(/^req_/);
    expect(res.body.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it.each([
    ['invalid_request', 400, 'invalid_request'],
    ['rate_limited', 429, 'rate_limited'],
    ['provider_timeout', 504, 'provider_timeout'],
    ['provider_auth', 502, 'provider_error'],
    ['provider_error', 502, 'provider_error'],
  ] as const)('maps a %s provider failure to HTTP %i', async (kind, status, type) => {
    const adapter = new FakeAdapter('mock', () => {
      throw new ProviderError(kind, 'mock', 'upstream said no', undefined, 3);
    });
    const { send } = make({ adapter });
    const res = await send(valid);
    expect(res.statusCode).toBe(status);
    expect(res.json().error.type).toBe(type);
    if (kind === 'rate_limited') expect(res.headers['retry-after']).toBe('3');
  });
});
