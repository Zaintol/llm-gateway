import type { Redis } from 'ioredis';

/** Slows API key brute forcing by capping failed authentication attempts per client IP. */
export interface FailureLimiter {
  isBlocked(ip: string): Promise<boolean>;
  recordFailure(ip: string): Promise<void>;
}

export class RedisFailureLimiter implements FailureLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly options: {
      limit?: number;
      windowSeconds?: number;
      onError?: (err: unknown) => void;
    } = {},
  ) {}

  get windowSeconds(): number {
    return this.options.windowSeconds ?? 60;
  }

  private key(ip: string): string {
    const window = Math.floor(Date.now() / 1000 / this.windowSeconds);
    return `gw:authfail:${ip}:${window}`;
  }

  // Fails open: a Redis outage must not lock every client out. Budgets fail closed separately.
  async isBlocked(ip: string): Promise<boolean> {
    try {
      const count = Number((await this.redis.get(this.key(ip))) ?? 0);
      return count >= (this.options.limit ?? 20);
    } catch (err) {
      this.options.onError?.(err);
      return false;
    }
  }

  async recordFailure(ip: string): Promise<void> {
    try {
      await this.redis
        .multi()
        .incr(this.key(ip))
        .expire(this.key(ip), this.windowSeconds * 2)
        .exec();
    } catch (err) {
      this.options.onError?.(err);
    }
  }
}
