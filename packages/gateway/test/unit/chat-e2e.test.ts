import { buildApp as buildMockProvider } from '@gw/mock-provider';
import type { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { chatRoutes } from '../../src/chat/route.js';
import { OpenAiCompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { StaticCredentials, fakeAuth } from '../support/fakes.js';

/**
 * Real HTTP end to end: official OpenAI SDK -> gateway -> OpenAI adapter -> mock provider
 * standing in for api.openai.com.
 */
let upstream: FastifyInstance;
let gateway: FastifyInstance;
let upstreamUrl: string;
let client: OpenAI;

beforeAll(async () => {
  upstream = buildMockProvider({ logLevel: 'silent' });
  upstreamUrl = await upstream.listen({ host: '127.0.0.1', port: 0 });

  const fakes = fakeAuth();
  const { key } = fakes.store.add();
  gateway = buildApp({
    logLevel: 'silent',
    readinessChecks: {},
    readinessTimeoutMs: 100,
    auth: fakes.auth,
    dataPlaneRoutes: [
      chatRoutes({
        providers: new ProviderRegistry([new OpenAiCompatibleAdapter({ provider: 'openai' })]),
        credentials: new StaticCredentials({
          openai: { secret: 'sk-upstream-test', baseUrl: `${upstreamUrl}/v1`, scope: 'tenant' },
        }),
        providerTimeoutMs: 5000,
      }),
    ],
  });
  const gatewayUrl = await gateway.listen({ host: '127.0.0.1', port: 0 });
  client = new OpenAI({ apiKey: key, baseURL: `${gatewayUrl}/v1`, maxRetries: 0 });
});

afterAll(async () => {
  await gateway?.close();
  await upstream?.close();
});

const lastUpstreamRequest = async () =>
  (
    (await (await fetch(`${upstreamUrl}/mock/requests`)).json()) as Array<{
      headers: Record<string, string>;
      body: Record<string, unknown>;
    }>
  )[0]!;

describe('OpenAI SDK through the gateway', () => {
  it('parses a completion with id, choices, usage and an x-request-id header', async () => {
    const { data, response } = await client.chat.completions
      .create({ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'ping' }] })
      .withResponse();

    expect(data.id).toMatch(/^chatcmpl-/);
    expect(data.model).toBe('openai/gpt-4o-mini');
    expect(data.choices[0]!.message.content).toBe('Mock reply to: ping');
    expect(data.usage).toMatchObject({
      prompt_tokens: expect.any(Number),
      completion_tokens: expect.any(Number),
    });
    expect(response.headers.get('x-request-id')).toMatch(/^req_/);
    expect(response.headers.get('x-gateway-provider')).toBe('openai');
  });

  it('calls upstream with the tenant credential and the upstream model name', async () => {
    await client.chat.completions.create({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'x' }],
    });
    const upstreamRequest = await lastUpstreamRequest();
    expect(upstreamRequest.headers.authorization).toBe('Bearer sk-upstream-test');
    expect(upstreamRequest.body.model).toBe('gpt-4o-mini');
  });

  it('does not forward unknown top-level fields to the provider', async () => {
    const res = await client.chat.completions.create({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'x' }],
      // @ts-expect-error deliberately unknown field
      not_a_real_field: 'drop me',
      gateway: { min_quality_tier: 1 },
    });
    expect(res.choices).toHaveLength(1);
    const body = (await lastUpstreamRequest()).body;
    expect(body).not.toHaveProperty('not_a_real_field');
    expect(body).not.toHaveProperty('gateway');
  });

  it('surfaces an upstream 400 as a 400 invalid_request APIError in the SDK', async () => {
    const err = await client.chat.completions
      .create({ model: 'openai/mock-bad-request', messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAI.APIError);
    expect((err as InstanceType<typeof OpenAI.APIError>).status).toBe(400);
    expect((err as InstanceType<typeof OpenAI.APIError>).type).toBe('invalid_request');
  });

  it('surfaces an upstream 429 as 429 rate_limited with retry-after', async () => {
    const err = (await client.chat.completions
      .create({ model: 'openai/mock-rate-limit', messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e)) as InstanceType<typeof OpenAI.APIError>;
    expect(err.status).toBe(429);
    expect(err.headers?.get('retry-after')).toBe('1');
  });
});
