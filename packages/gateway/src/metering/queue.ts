import { Queue, type ConnectionOptions } from 'bullmq';
import type { UsageEvent } from './event.js';

export const USAGE_QUEUE = 'usage-events';

/** BullMQ connection options from a redis:// or rediss:// URL. */
export function redisConnection(
  url: string,
  overrides: Record<string, unknown> = {},
): ConnectionOptions {
  const u = new URL(url);
  const db = u.pathname.replace('/', '');
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(db ? { db: Number(db) } : {}),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    ...overrides,
  } as ConnectionOptions;
}

export type UsageJobOptions = { attempts: number; backoffMs: number };

/**
 * Producer side. The connection does not queue commands while Redis is down, so `add` fails fast
 * and the caller can spill the event to disk instead of blocking the request path.
 */
export function createUsageQueue(redisUrl: string, jobs: UsageJobOptions): Queue<UsageEvent> {
  return new Queue<UsageEvent>(USAGE_QUEUE, {
    connection: redisConnection(redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1 }),
    defaultJobOptions: {
      attempts: jobs.attempts,
      backoff: { type: 'exponential', delay: jobs.backoffMs },
      removeOnComplete: { age: 3600, count: 10_000 },
      // Failed jobs are kept: the failed set is the dead-letter queue.
      removeOnFail: false,
    },
  });
}
