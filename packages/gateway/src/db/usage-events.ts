import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { usageEvents } from './schema.js';

export type NewUsageEvent = typeof usageEvents.$inferInsert;

/** Postgres raises check_violation (23514) when no partition accepts the row. */
function isMissingPartitionError(err: unknown): boolean {
  const cause = err instanceof Error && 'cause' in err ? err.cause : err;
  const pgError = cause as { code?: string; message?: string } | undefined;
  return pgError?.code === '23514' && /no partition of relation/.test(pgError.message ?? '');
}

/**
 * Inserts a usage event. If the event falls in a month that has no partition yet, the partition
 * is created on demand and the insert is retried once. The common path costs a single round trip.
 */
export async function insertUsageEvent(db: Db, event: NewUsageEvent): Promise<void> {
  try {
    await db.insert(usageEvents).values(event);
  } catch (err) {
    if (!isMissingPartitionError(err)) throw err;
    const createdAt = event.createdAt ?? new Date();
    await db.execute(sql`select ensure_usage_events_partition(${createdAt.toISOString()})`);
    await db.insert(usageEvents).values(event);
  }
}
