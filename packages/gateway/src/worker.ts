/**
 * Usage worker: consumes usage events from the queue and writes them to Postgres. Runs as its
 * own process so metering never competes with request handling.
 */
import { Queue } from 'bullmq';
import pino from 'pino';
import { z } from 'zod';
import { createDb, createPool } from './db/client.js';
import { USAGE_QUEUE, redisConnection } from './metering/queue.js';
import { startUsageWorker } from './metering/worker.js';

const env = z
  .object({
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    LOG_LEVEL: z.string().default('info'),
    USAGE_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
    /** How often the dead-letter depth is logged (the metric arrives with GW-8.3). */
    USAGE_DLQ_REPORT_MS: z.coerce.number().int().positive().default(60_000),
  })
  .safeParse(process.env);
if (!env.success) {
  console.error(
    `Invalid configuration:\n${env.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`,
  );
  process.exit(1);
}
const config = env.data;
const log = pino({ level: config.LOG_LEVEL, name: 'usage-worker' });

const pool = createPool(config.DATABASE_URL);
const db = createDb(pool);
pool.on('error', (err) => log.warn({ err: err.message }, 'postgres pool error'));
// Workers must keep retrying Redis indefinitely (BullMQ requirement).
const connection = redisConnection(config.REDIS_URL, { maxRetriesPerRequest: null });

const worker = startUsageWorker({
  db,
  connection,
  concurrency: config.USAGE_WORKER_CONCURRENCY,
  log,
});

const queue = new Queue(USAGE_QUEUE, { connection });
const dlqTimer = setInterval(async () => {
  try {
    const depth = await queue.getFailedCount();
    log[depth > 0 ? 'warn' : 'debug']({ dlqDepth: depth }, 'usage dead-letter queue depth');
  } catch (err) {
    log.warn({ err }, 'could not read dead-letter queue depth');
  }
}, config.USAGE_DLQ_REPORT_MS);

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down');
  clearInterval(dlqTimer);
  await worker.close();
  await queue.close();
  await pool.end();
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
log.info(
  { queue: USAGE_QUEUE, concurrency: config.USAGE_WORKER_CONCURRENCY },
  'usage worker started',
);
