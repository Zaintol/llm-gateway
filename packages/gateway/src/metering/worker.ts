import { Worker, type ConnectionOptions } from 'bullmq';
import type { Db } from '../db/client.js';
import { insertUsageEvent } from '../db/usage-events.js';
import { toUsageEventRow, usageEventSchema, type UsageEvent } from './event.js';
import { USAGE_QUEUE } from './queue.js';

/** Persists one queued usage event. Idempotent on request_id, so redelivery is harmless. */
export async function persistUsageEvent(db: Db, data: unknown): Promise<void> {
  const event = usageEventSchema.parse(data);
  await insertUsageEvent(db, toUsageEventRow(event));
}

type Logger = {
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

export function startUsageWorker(options: {
  db: Db;
  connection: ConnectionOptions;
  concurrency?: number;
  log: Logger;
  /** Test hook: replaces the database write. */
  persist?: (data: unknown) => Promise<void>;
}): Worker<UsageEvent> {
  const persist = options.persist ?? ((data: unknown) => persistUsageEvent(options.db, data));
  const worker = new Worker<UsageEvent>(USAGE_QUEUE, (job) => persist(job.data), {
    connection: options.connection,
    concurrency: options.concurrency ?? 10,
  });
  worker.on('failed', (job, err) => {
    const exhausted = job && job.attemptsMade >= (job.opts.attempts ?? 1);
    options.log[exhausted ? 'error' : 'warn'](
      { requestId: job?.id, attemptsMade: job?.attemptsMade, err: err.message },
      exhausted
        ? 'usage event moved to dead-letter queue'
        : 'usage event insert failed; will retry',
    );
  });
  worker.on('error', (err) => options.log.warn({ err: err.message }, 'usage worker error'));
  return worker;
}
