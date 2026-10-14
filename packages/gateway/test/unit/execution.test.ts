import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { StaticCatalog } from '../../src/catalog/catalog.js';
import { chatRoutes } from '../../src/chat/route.js';
import { ExecutionEngine } from '../../src/execution/engine.js';
import { ProviderError, type ProviderErrorKind } from '../../src/providers/errors.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type { ProviderResult } from '../../src/providers/types.js';
import {
  FakeAdapter,
  StaticCredentials,
  cannedResult,
  catalogModel,
  fakeAuth,
} from '../support/fakes.js';

/** A step in a scripted provider: succeed, fail with a kind, or hang until aborted. */
type Step =
  | 'ok'
  | ProviderErrorKind
  | { kind: ProviderErrorKind; retryAfter?: number; status?: number }
  | 'hang';

function scripted(provider: string, steps: Step[]) {
  let i = 0;
  const adapter = new FakeAdapter(provider, async (req): Promise<ProviderResult> => {
    const step = steps[Math.min(i++, steps.length - 1)]!;
    if (step === 'ok') return cannedResult(req.model, `from ${provider}`);
    if (step === 'hang') {
      // Like a real adapter: wait until the engine aborts the attempt, then report a timeout.
      const signal = adapter.calls.at(-1)!.call.signal;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      throw new ProviderError('provider_timeout', provider, `${provider} did not respond in time`);
    }
    const { kind, retryAfter, status } =
      typeof step === 'string' ? { kind: step, retryAfter: undefined, status: undefined } : step;
    throw new ProviderError(kind, provider, `${provider} failed with ${kind}`, status, retryAfter);
  });
  return adapter;
}

const catalog = new StaticCatalog(
  [
    catalogModel({
      id: 'openai/gpt',
      provider: 'openai',
      upstreamModel: 'gpt',
      capabilities: { tools: true, vision: true, jsonMode: true, streaming: true },
    }),
    catalogModel({
      id: 'anthropic/claude',
      provider: 'anthropic',
      upstreamModel: 'claude',
      capabilities: { tools: false, vision: true, jsonMode: false, streaming: true },
    }),
    catalogModel({
      id: 'local/llama',
      provider: 'local',
      upstreamModel: 'llama',
      capabilities: { tools: true, vision: false, jsonMode: true, streaming: true },
    }),
  ],
  [
    {
      id: 'gw/resilient',
      description: 'test chain',
      requirements: {},
      fallbackChain: ['openai/gpt', 'anthropic/claude', 'local/llama'],
      enabled: true,
    },
  ],
);

let app: FastifyInstance;
afterEach(() => app?.close());

function make(
  adapters: FakeAdapter[],
  engine = new ExecutionEngine({ sleep: async () => {} }),
  tenantSettings: Record<string, unknown> = {},
) {
  const fakes = fakeAuth();
  const { key } = fakes.store.add({ tenantSettings });
  app = buildApp({
    logLevel: 'silent',
    readinessChecks: {},
    readinessTimeoutMs: 50,
    auth: fakes.auth,
    dataPlaneRoutes: [
      chatRoutes({
        providers: new ProviderRegistry(adapters, catalog),
        catalog,
        credentials: new StaticCredentials(),
        engine,
      }),
    ],
  });
  return (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}`, ...headers },
      payload: { messages: [{ role: 'user', content: 'hi' }], ...payload },
    });
}

describe('retries (GW-3.2)', () => {
  it('recovers from one 503 and reports 2 attempts', async () => {
    const openai = scripted('openai', [{ kind: 'provider_error', status: 503 }, 'ok']);
    const res = await make([openai])({ model: 'openai/gpt' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-gateway-attempts']).toBe('2');
  });

  it('does not wait out a Retry-After longer than the deadline; it falls back at once', async () => {
    const slept: number[] = [];
    const engine = new ExecutionEngine({ sleep: async (ms) => void slept.push(ms) });
    const openai = scripted('openai', [{ kind: 'rate_limited', retryAfter: 30, status: 429 }]);
    const anthropic = scripted('anthropic', ['ok']);
    const started = Date.now();
    const res = await make([openai, anthropic], engine)(
      { model: 'gw/resilient' },
      { 'x-gateway-timeout-ms': '10000' },
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-gateway-provider']).toBe('anthropic');
    expect(openai.calls).toHaveLength(1);
    expect(slept).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('waits for a Retry-After that fits in the deadline', async () => {
    const slept: number[] = [];
    const engine = new ExecutionEngine({
      sleep: async (ms) => void slept.push(ms),
      random: () => 0,
    });
    const openai = scripted('openai', [{ kind: 'rate_limited', retryAfter: 2 }, 'ok']);
    const res = await make([openai], engine)({ model: 'openai/gpt' });
    expect(res.statusCode).toBe(200);
    expect(slept).toEqual([2000]);
  });

  it('never retries a 400', async () => {
    const openai = scripted('openai', [{ kind: 'invalid_request', status: 400 }]);
    const res = await make([openai])({ model: 'openai/gpt' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['x-gateway-attempts']).toBe('1');
    expect(openai.calls).toHaveLength(1);
  });

  it('gives up with 502 after exactly 3 attempts when a lone provider always fails', async () => {
    const openai = scripted('openai', [{ kind: 'provider_error', status: 500 }]);
    const res = await make([openai])({ model: 'openai/gpt' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.type).toBe('provider_error');
    expect(res.headers['x-gateway-attempts']).toBe('3');
    expect(openai.calls).toHaveLength(3);
  });
});

describe('fallback chains (GW-3.4)', () => {
  it('serves from anthropic when openai returns 503 on every attempt', async () => {
    const openai = scripted('openai', [{ kind: 'provider_error', status: 503 }]);
    const anthropic = scripted('anthropic', ['ok']);
    const local = scripted('local', ['ok']);
    const res = await make([openai, anthropic, local])({ model: 'gw/resilient' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-gateway-provider']).toBe('anthropic');
    expect(res.headers['x-gateway-model']).toBe('anthropic/claude');
    expect(res.headers['x-gateway-attempts']).toBe('4');
    expect(res.json().choices[0].message.content).toBe('from anthropic');
    expect(local.calls).toHaveLength(0);
  });

  it('does not fall back for a concrete model unless asked', async () => {
    const openai = scripted('openai', [{ kind: 'provider_error', status: 503 }]);
    const anthropic = scripted('anthropic', ['ok']);
    const res = await make([openai, anthropic])({ model: 'openai/gpt' });
    expect(res.statusCode).toBe(502);
    expect(anthropic.calls).toHaveLength(0);
  });

  it("appends the tenant's default chain to a concrete model when gateway.fallback is true", async () => {
    const openai = scripted('openai', [{ kind: 'provider_error', status: 503 }]);
    const local = scripted('local', ['ok']);
    const send = make([openai, local], undefined, { fallback_chain: ['local/llama'] });
    const res = await send({ model: 'openai/gpt', gateway: { fallback: true } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-gateway-provider']).toBe('local');
  });

  it('skips a chain entry that lacks tool support and tries the next one', async () => {
    const openai = scripted('openai', [{ kind: 'provider_error' }]);
    const anthropic = scripted('anthropic', ['ok']);
    const local = scripted('local', ['ok']);
    const res = await make([openai, anthropic, local])({
      model: 'gw/resilient',
      tools: [{ type: 'function', function: { name: 'lookup' } }],
    });
    expect(res.statusCode).toBe(200);
    expect(anthropic.calls).toHaveLength(0);
    expect(res.headers['x-gateway-provider']).toBe('local');
  });

  it('lists every provider and its canonical error when all candidates fail', async () => {
    const res = await make([
      scripted('openai', [{ kind: 'provider_error', status: 503 }]),
      scripted('anthropic', [{ kind: 'provider_auth', status: 401 }]),
      scripted('local', [{ kind: 'rate_limited', status: 429 }]),
    ])({ model: 'gw/resilient' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatchObject({
      type: 'provider_error',
      code: 'all_candidates_failed',
    });
    expect(res.json().error.message).toBe(
      'All 3 candidates failed: openai/gpt: provider_error (HTTP 503) after 3 attempts; ' +
        'anthropic/claude: provider_auth (HTTP 401) after 1 attempt; local/llama: rate_limited (HTTP 429) after 3 attempts',
    );
  });

  it('does not fall back when the first provider rejects the request as invalid', async () => {
    const anthropic = scripted('anthropic', ['ok']);
    const res = await make([
      scripted('openai', [{ kind: 'invalid_request', status: 400 }]),
      anthropic,
    ])({ model: 'gw/resilient' });
    expect(res.statusCode).toBe(400);
    expect(anthropic.calls).toHaveLength(0);
  });

  it('returns 400 no_eligible_model listing why each candidate was skipped', async () => {
    // Every model in the test catalog has a 32k context window, so 40k output tokens fit none.
    const openai = scripted('openai', ['ok']);
    const res = await make([openai, scripted('anthropic', ['ok'])])({
      model: 'gw/resilient',
      tools: [{ type: 'function', function: { name: 'f' } }],
      max_tokens: 40_000,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe('no_eligible_model');
    expect(res.json().error.message).toMatch(
      /^No model can serve this request: openai\/gpt \(lacks context_window >= \d+ \(has 32000\)\); anthropic\/claude \(lacks tools, context_window >= \d+ \(has 32000\)\); local\/llama \(provider_not_available\)$/,
    );
    expect(openai.calls).toHaveLength(0);
  });
});

describe('timeouts (GW-3.1)', () => {
  it('aborts an attempt that exceeds the attempt timeout and tries the next candidate', async () => {
    const engine = new ExecutionEngine({ attemptTimeoutMs: 50, maxRetries: 0 });
    const openai = scripted('openai', ['hang']);
    const anthropic = scripted('anthropic', ['ok']);
    const res = await make([openai, anthropic], engine)({ model: 'gw/resilient' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-gateway-provider']).toBe('anthropic');
    expect(openai.calls[0]!.call.signal.aborted).toBe(true);
  });

  it('returns 504 provider_timeout within 5.5 s when every provider is slower than a 5 s deadline', async () => {
    const engine = new ExecutionEngine({ attemptTimeoutMs: 60_000 });
    const send = make(
      [scripted('openai', ['hang']), scripted('anthropic', ['hang']), scripted('local', ['hang'])],
      engine,
    );
    const started = Date.now();
    const res = await send({ model: 'gw/resilient' }, { 'x-gateway-timeout-ms': '5000' });
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(504);
    expect(res.json().error).toMatchObject({ type: 'provider_timeout', code: 'deadline_exceeded' });
    expect(elapsed).toBeGreaterThanOrEqual(4900);
    expect(elapsed).toBeLessThan(5500);
  }, 10_000);

  it('caps x-gateway-timeout-ms at 300000 and reports the effective deadline', async () => {
    const res = await make([scripted('openai', ['ok'])])(
      { model: 'openai/gpt' },
      { 'x-gateway-timeout-ms': '900000' },
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-gateway-deadline-ms']).toBe('300000');
  });

  it('rejects a malformed x-gateway-timeout-ms', async () => {
    const res = await make([scripted('openai', ['ok'])])(
      { model: 'openai/gpt' },
      { 'x-gateway-timeout-ms': 'soon' },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_timeout');
  });
});

describe('ExecutionEngine.backoff', () => {
  it('uses full jitter bounded by min(cap, base * 2^retry)', () => {
    const max = new ExecutionEngine({
      random: () => 0.999999,
      backoffBaseMs: 200,
      backoffCapMs: 2000,
    });
    expect([0, 1, 2, 3, 4].map((r) => max.backoff(r))).toEqual([199, 399, 799, 1599, 1999]);
    expect(new ExecutionEngine({ random: () => 0 }).backoff(3)).toBe(0);
  });
});
