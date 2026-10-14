import { describe, expect, it } from 'vitest';
import { rateLimitDegraded, registry } from '../../src/observability/metrics.js';
import { RedisRateLimiter } from '../../src/ratelimit/limiter.js';
import { createRedis } from '../../src/redis.js';

const degradedCount = async () =>
  (await registry.getSingleMetricAsString('gateway_ratelimit_degraded_total'))
    .split('\n')
    .find((l) => l.startsWith('gateway_ratelimit_degraded_total '))!
    .split(' ')[1];

describe('RedisRateLimiter when Redis is unavailable', () => {
  it('admits the request and counts the degraded decision', async () => {
    const redis = createRedis('redis://127.0.0.1:1');
    redis.on('error', () => {});
    const errors: unknown[] = [];
    const limiter = new RedisRateLimiter(redis, (err) => errors.push(err));
    const before = Number(await degradedCount());

    const admission = await limiter.admit({
      keyId: 'k',
      tenantId: 't',
      limits: { key: { rpm: 1, tpm: 1 }, tenant: { rpm: 1, tpm: 1 } },
      estimatedTokens: 5_000,
    });
    expect(admission.headers).toEqual({});
    expect(Number(await degradedCount())).toBe(before + 1);
    expect(errors).toHaveLength(1);
    expect(rateLimitDegraded).toBeDefined();
    redis.disconnect();
  });

  it('does not touch Redis when no limits apply', async () => {
    const limiter = new RedisRateLimiter(createRedis('redis://127.0.0.1:1'));
    const admission = await limiter.admit({
      keyId: 'k',
      tenantId: 't',
      limits: { key: { rpm: null, tpm: null }, tenant: { rpm: null, tpm: null } },
      estimatedTokens: 1,
    });
    expect(admission).toEqual({ headers: {}, tokenBuckets: [], estimatedTokens: 1 });
  });
});
