import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { RateLimits } from '../../src/auth/key-store.js';
import { chatRoutes } from '../../src/chat/route.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { RedisRateLimiter } from '../../src/ratelimit/limiter.js';
import { createRedis } from '../../src/redis.js';
import { FakeAdapter, StaticCredentials, cannedResult, fakeAuth } from '../support/fakes.js';

let container: StartedRedisContainer;
let redis: Redis;
let app: FastifyInstance;

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = createRedis(container.getConnectionUrl());
  await redis.connect();
});
afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
});
afterEach(async () => {
  await app?.close();
  await redis.flushall();
});

const unlimited = { rpm: null, tpm: null };

function make(limits: Partial<RateLimits>, tenantId = 'tenant_rl') {
  const adapter = new FakeAdapter('mock', (req) => cannedResult(req.model));
  const fakes = fakeAuth();
  const { key } = fakes.store.add({
    tenantId,
    limits: { key: unlimited, tenant: unlimited, ...limits },
  });
  app = buildApp({
    logLevel: 'silent',
    readinessChecks: {},
    readinessTimeoutMs: 100,
    auth: fakes.auth,
    dataPlaneRoutes: [
      chatRoutes({
        providers: new ProviderRegistry([adapter]),
        credentials: new StaticCredentials(),
        rateLimiter: new RedisRateLimiter(redis),
      }),
    ],
  });
  const send = (extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: {
        model: 'mock/fast',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10,
        ...extra,
      },
    });
  return { adapter, send, fakes };
}

describe('request and token rate limits (GW-5.1)', () => {
  it('rejects the 11th request in a minute for a key limited to 10 RPM', async () => {
    const { send } = make({ key: { rpm: 10, tpm: null } });
    for (let i = 0; i < 10; i++) expect((await send()).statusCode).toBe(200);
    const res = await send();
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatchObject({ type: 'rate_limited', code: 'rate_limit_requests' });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(6);
  });

  it('rejects a request whose token estimate exceeds the tenant TPM limit before any provider call', async () => {
    const { send, adapter } = make({ tenant: { rpm: null, tpm: 10_000 } });
    const res = await send({ max_tokens: 12_000 });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limit_tokens');
    expect(res.json().error.message).toMatch(
      /more than the tenant limit of 10000 tokens per minute/,
    );
    expect(adapter.calls).toHaveLength(0);
  });

  it('applies the stricter tenant limit when the key limit is higher', async () => {
    const { send } = make({ key: { rpm: 100, tpm: null }, tenant: { rpm: 50, tpm: null } });
    const statuses: number[] = [];
    for (let i = 0; i < 55; i++) statuses.push((await send()).statusCode);
    expect(statuses.filter((s) => s === 200)).toHaveLength(50);
    expect(statuses.slice(50).every((s) => s === 429)).toBe(true);
  });

  it('admits exactly the limit under concurrency', async () => {
    const { send, adapter } = make({ key: { rpm: 10, tpm: null } });
    const results = await Promise.all(Array.from({ length: 30 }, () => send()));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(10);
    expect(adapter.calls).toHaveLength(10);
  });

  it('returns the four x-ratelimit headers with remaining values that decrease', async () => {
    const { send } = make({ key: { rpm: 20, tpm: 100_000 } });
    const first = await send();
    const second = await send();
    for (const res of [first, second]) {
      expect(res.headers['x-ratelimit-limit-requests']).toBe('20');
      expect(res.headers['x-ratelimit-limit-tokens']).toBe('100000');
    }
    expect(Number(second.headers['x-ratelimit-remaining-requests'])).toBeLessThan(
      Number(first.headers['x-ratelimit-remaining-requests']),
    );
    expect(Number(second.headers['x-ratelimit-remaining-tokens'])).toBeLessThan(
      Number(first.headers['x-ratelimit-remaining-tokens']),
    );
  });

  it('omits rate limit headers when no limits are configured', async () => {
    const { send } = make({});
    const res = await send();
    expect(res.headers['x-ratelimit-limit-requests']).toBeUndefined();
  });

  it('credits back the difference between the estimate and actual tokens', async () => {
    const limiter = new RedisRateLimiter(redis);
    const limits = { key: { rpm: null, tpm: 10_000 }, tenant: unlimited };
    const admission = await limiter.admit({
      keyId: 'k1',
      tenantId: 't1',
      limits,
      estimatedTokens: 5_000,
    });
    expect(admission.headers['x-ratelimit-remaining-tokens']).toBe('5000');
    await limiter.settle(admission, 100);
    // With the 4,900 credit back, a 9,800-token request now fits; without it, it would not.
    const next = await limiter.admit({
      keyId: 'k1',
      tenantId: 't1',
      limits,
      estimatedTokens: 9_800,
    });
    expect(Number(next.headers['x-ratelimit-remaining-tokens'])).toBeLessThan(200);
  });

  it('debits extra tokens when the actual usage exceeds the estimate', async () => {
    const limiter = new RedisRateLimiter(redis);
    const limits = { key: { rpm: null, tpm: 10_000 }, tenant: unlimited };
    const admission = await limiter.admit({
      keyId: 'k2',
      tenantId: 't2',
      limits,
      estimatedTokens: 1_000,
    });
    await limiter.settle(admission, 9_000);
    await expect(
      limiter.admit({ keyId: 'k2', tenantId: 't2', limits, estimatedTokens: 2_000 }),
    ).rejects.toMatchObject({
      code: 'rate_limit_tokens',
    });
  });
});
