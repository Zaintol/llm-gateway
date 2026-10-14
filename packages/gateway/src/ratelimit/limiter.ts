import type { Redis } from 'ioredis';
import type { RateLimits } from '../auth/key-store.js';
import { GatewayError } from '../errors.js';
import { rateLimitDegraded } from '../observability/metrics.js';

/**
 * Token buckets refilled continuously at capacity / 60s. One call checks every applicable bucket
 * and debits all of them only if all allow it, so concurrent requests cannot jointly exceed a
 * limit. Time comes from Redis so gateway clock skew does not matter.
 * Returns {deniedIndex (0 = allowed), retryAfterSeconds (-1 = can never fit), remaining...}.
 */
const ADMIT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local n = #KEYS
local levels = {}
local denied, retry = 0, 0
for i = 1, n do
  local cap = tonumber(ARGV[2 * i - 1])
  local cost = tonumber(ARGV[2 * i])
  local rate = cap / 60000
  local state = redis.call('HMGET', KEYS[i], 'tokens', 'ts')
  local tokens = tonumber(state[1]) or cap
  local ts = tonumber(state[2]) or now
  tokens = math.min(cap, tokens + math.max(0, now - ts) * rate)
  levels[i] = tokens
  if denied == 0 and cost > tokens then
    denied = i
    if cost > cap then retry = -1 else retry = math.ceil((cost - tokens) / rate / 1000) end
  end
end
local out = { denied, retry }
for i = 1, n do
  local left = levels[i]
  if denied == 0 then
    left = levels[i] - tonumber(ARGV[2 * i])
    redis.call('HSET', KEYS[i], 'tokens', tostring(left), 'ts', tostring(now))
    redis.call('PEXPIRE', KEYS[i], 120000)
  end
  out[#out + 1] = math.floor(math.max(0, left))
end
return out
`;

/** Applies a correction (positive = debit, negative = credit) to token buckets after a call. */
const ADJUST = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
for i = 1, #KEYS do
  local cap = tonumber(ARGV[2 * i - 1])
  local delta = tonumber(ARGV[2 * i])
  local state = redis.call('HMGET', KEYS[i], 'tokens', 'ts')
  local tokens = tonumber(state[1]) or cap
  local ts = tonumber(state[2]) or now
  tokens = math.min(cap, tokens + math.max(0, now - ts) * cap / 60000) - delta
  redis.call('HSET', KEYS[i], 'tokens', tostring(math.min(cap, tokens)), 'ts', tostring(now))
  redis.call('PEXPIRE', KEYS[i], 120000)
end
return 1
`;

type Bucket = { key: string; kind: 'requests' | 'tokens'; capacity: number; cost: number };

export type Admission = {
  headers: Record<string, string>;
  /** Token buckets charged with the estimate, corrected once actual usage is known. */
  tokenBuckets: Array<{ key: string; capacity: number }>;
  estimatedTokens: number;
};

export interface RateLimiter {
  admit(input: {
    keyId: string;
    tenantId: string;
    limits: RateLimits;
    estimatedTokens: number;
  }): Promise<Admission>;
  settle(admission: Admission, actualTokens: number): Promise<void>;
}

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  async admit(input: {
    keyId: string;
    tenantId: string;
    limits: RateLimits;
    estimatedTokens: number;
  }): Promise<Admission> {
    const { limits, estimatedTokens } = input;
    const buckets: Bucket[] = [];
    const add = (scope: string, kind: Bucket['kind'], capacity: number | null, cost: number) => {
      if (capacity !== null) {
        buckets.push({
          key: `gw:rl:${scope}:${kind === 'requests' ? 'rpm' : 'tpm'}`,
          kind,
          capacity,
          cost,
        });
      }
    };
    add(`key:${input.keyId}`, 'requests', limits.key.rpm, 1);
    add(`key:${input.keyId}`, 'tokens', limits.key.tpm, estimatedTokens);
    add(`tenant:${input.tenantId}`, 'requests', limits.tenant.rpm, 1);
    add(`tenant:${input.tenantId}`, 'tokens', limits.tenant.tpm, estimatedTokens);
    const none: Admission = { headers: {}, tokenBuckets: [], estimatedTokens };
    if (buckets.length === 0) return none;

    let result: number[];
    try {
      result = (await this.redis.eval(
        ADMIT,
        buckets.length,
        ...buckets.map((b) => b.key),
        ...buckets.flatMap((b) => [b.capacity, b.cost]),
      )) as number[];
    } catch (err) {
      // Fail open: an outage of the limiter must not take the gateway down with it.
      rateLimitDegraded.inc();
      this.onError(err);
      return none;
    }

    const [denied, retryAfter, ...remaining] = result;
    const headers = headersFor(buckets, remaining);
    if (denied! > 0) {
      const bucket = buckets[denied! - 1]!;
      const code = bucket.kind === 'requests' ? 'rate_limit_requests' : 'rate_limit_tokens';
      const scope = bucket.key.includes(':tenant:') ? 'tenant' : 'API key';
      const message =
        retryAfter === -1
          ? `This request needs ~${bucket.cost} tokens, more than the ${scope} limit of ${bucket.capacity} tokens per minute`
          : `${scope === 'tenant' ? 'Tenant' : 'API key'} ${bucket.kind === 'requests' ? 'requests' : 'tokens'} per minute limit of ${bucket.capacity} reached`;
      throw new GatewayError(429, 'rate_limited', code, message, {
        ...headers,
        ...(retryAfter! > 0 ? { 'retry-after': String(retryAfter) } : {}),
      });
    }
    return {
      headers,
      tokenBuckets: buckets
        .filter((b) => b.kind === 'tokens')
        .map(({ key, capacity }) => ({ key, capacity })),
      estimatedTokens,
    };
  }

  /** Replaces the admission estimate with the actual token count (debit or credit). */
  async settle(admission: Admission, actualTokens: number): Promise<void> {
    const delta = actualTokens - admission.estimatedTokens;
    if (admission.tokenBuckets.length === 0 || delta === 0) return;
    try {
      await this.redis.eval(
        ADJUST,
        admission.tokenBuckets.length,
        ...admission.tokenBuckets.map((b) => b.key),
        ...admission.tokenBuckets.flatMap((b) => [b.capacity, delta]),
      );
    } catch (err) {
      this.onError(err);
    }
  }
}

/** OpenAI-style headers describing the most constrained request and token buckets. */
function headersFor(buckets: Bucket[], remaining: number[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const kind of ['requests', 'tokens'] as const) {
    let tightest: { capacity: number; remaining: number } | undefined;
    buckets.forEach((b, i) => {
      if (b.kind !== kind) return;
      const left = remaining[i] ?? 0;
      if (!tightest || left < tightest.remaining)
        tightest = { capacity: b.capacity, remaining: left };
    });
    if (tightest) {
      headers[`x-ratelimit-limit-${kind}`] = String(tightest.capacity);
      headers[`x-ratelimit-remaining-${kind}`] = String(tightest.remaining);
    }
  }
  return headers;
}

export const noopRateLimiter: RateLimiter = {
  admit: async ({ estimatedTokens }) => ({ headers: {}, tokenBuckets: [], estimatedTokens }),
  settle: async () => {},
};
