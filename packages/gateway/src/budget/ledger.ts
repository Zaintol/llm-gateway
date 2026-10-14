import type { Redis } from 'ioredis';

/**
 * Atomic budget accounting in Redis. Each period counter holds settled spend plus open
 * reservations in micro-USD. Every mutation is a single Lua script, so concurrent requests cannot
 * jointly overshoot a hard limit: the worst case is bounded by one reservation, not by concurrency.
 *
 * Amounts are micro-USD. Lua numbers are doubles printed with 14 significant digits, so counters
 * stay exact up to 1e14 micro-USD (100 million USD) per tenant and period.
 *
 * Leases record each open reservation (hash LEASES: requestId -> {keys, amount}; sorted set DUE:
 * requestId by expiry) so the sweeper can refund reservations orphaned by a crashed instance.
 */
const LEASES = 'gw:budget:leases';
const DUE = 'gw:budget:leases:due';

/**
 * KEYS: counters. ARGV: requestId, amount, leaseExpiryMs, then per counter: hardLimit, ttlSeconds.
 * Extends an existing lease (fallback to a pricier model) or opens a new one.
 * Returns {0} on success, or {index of the counter that would exceed, its current value}.
 */
const RESERVE = `
local requestId, amount, expiry = ARGV[1], tonumber(ARGV[2]), ARGV[3]
for i = 1, #KEYS do
  local limit = tonumber(ARGV[2 + 2 * i])
  local current = tonumber(redis.call('GET', KEYS[i]) or '0')
  if current + amount > limit then return { i, current } end
end
for i = 1, #KEYS do
  redis.call('INCRBY', KEYS[i], ARGV[2])
  if redis.call('TTL', KEYS[i]) < 0 then redis.call('EXPIRE', KEYS[i], tonumber(ARGV[3 + 2 * i])) end
end
local lease = redis.call('HGET', '${LEASES}', requestId)
local held = 0
if lease then held = cjson.decode(lease).amount end
redis.call('HSET', '${LEASES}', requestId, cjson.encode({ keys = KEYS, amount = held + amount }))
redis.call('ZADD', '${DUE}', expiry, requestId)
return { 0 }
`;

/**
 * ARGV: requestId, actualCost. Applies (actual - reserved) to the leased counters. If the lease
 * was already refunded by the sweeper, the full actual cost is applied to the given KEYS.
 */
const SETTLE = `
local requestId, actual = ARGV[1], tonumber(ARGV[2])
local lease = redis.call('HGET', '${LEASES}', requestId)
local keys, reserved = KEYS, 0
if lease then
  local decoded = cjson.decode(lease)
  keys, reserved = decoded.keys, decoded.amount
  redis.call('HDEL', '${LEASES}', requestId)
  redis.call('ZREM', '${DUE}', requestId)
end
local delta = actual - reserved
if delta ~= 0 then
  for _, key in ipairs(keys) do redis.call('INCRBY', key, delta) end
end
return reserved
`;

/** ARGV: now, batch. Refunds expired leases. Returns how many were refunded. */
const SWEEP = `
local due = redis.call('ZRANGEBYSCORE', '${DUE}', '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
for _, requestId in ipairs(due) do
  local lease = redis.call('HGET', '${LEASES}', requestId)
  if lease then
    local decoded = cjson.decode(lease)
    for _, key in ipairs(decoded.keys) do redis.call('DECRBY', key, decoded.amount) end
    redis.call('HDEL', '${LEASES}', requestId)
  end
  redis.call('ZREM', '${DUE}', requestId)
end
return #due
`;

/**
 * KEYS: one counter. ARGV: settled total from Postgres, ttlSeconds. Sets the counter to the
 * Postgres total plus reservations still open against it, so in-flight requests stay covered.
 */
const RECONCILE = `
local open = 0
local leases = redis.call('HGETALL', '${LEASES}')
for i = 2, #leases, 2 do
  local decoded = cjson.decode(leases[i])
  for _, key in ipairs(decoded.keys) do
    if key == KEYS[1] then open = open + decoded.amount end
  end
end
local value = tonumber(ARGV[1]) + open
redis.call('SET', KEYS[1], value, 'EX', tonumber(ARGV[2]))
return value
`;

export type CounterLimit = { key: string; hardLimitMicros: bigint; ttlSeconds: number };
export type ReserveResult =
  { ok: true } | { ok: false; counter: CounterLimit; currentMicros: bigint };

export class BudgetLedger {
  constructor(
    private readonly redis: Redis,
    private readonly leaseMs = 10 * 60_000,
  ) {}

  async reserve(
    requestId: string,
    amountMicros: bigint,
    counters: CounterLimit[],
  ): Promise<ReserveResult> {
    const result = (await this.redis.eval(
      RESERVE,
      counters.length,
      ...counters.map((c) => c.key),
      requestId,
      amountMicros.toString(),
      String(Date.now() + this.leaseMs),
      ...counters.flatMap((c) => [c.hardLimitMicros.toString(), String(c.ttlSeconds)]),
    )) as number[];
    if (result[0] === 0) return { ok: true };
    return { ok: false, counter: counters[result[0]! - 1]!, currentMicros: BigInt(result[1]!) };
  }

  /** Returns the amount that had been reserved. */
  async settle(requestId: string, actualMicros: bigint, counterKeys: string[]): Promise<bigint> {
    const reserved = await this.redis.eval(
      SETTLE,
      counterKeys.length,
      ...counterKeys,
      requestId,
      actualMicros.toString(),
    );
    return BigInt(reserved as number);
  }

  async sweep(now = Date.now(), batch = 500): Promise<number> {
    return (await this.redis.eval(SWEEP, 0, String(now), String(batch))) as number;
  }

  async reconcile(counterKey: string, settledMicros: bigint, ttlSeconds: number): Promise<bigint> {
    return BigInt(
      (await this.redis.eval(
        RECONCILE,
        1,
        counterKey,
        settledMicros.toString(),
        String(ttlSeconds),
      )) as number,
    );
  }

  async current(counterKey: string): Promise<bigint> {
    return BigInt((await this.redis.get(counterKey)) ?? '0');
  }
}
