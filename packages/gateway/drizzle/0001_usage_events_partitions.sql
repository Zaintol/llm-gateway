-- Monthly (UTC) partitions for usage_events.
-- ensure_usage_events_partition() is idempotent and safe to call concurrently. The gateway calls it
-- when an insert lands in a month with no partition yet (see src/db/usage-events.ts), so writes
-- never fail on a month boundary even if no scheduled job has pre-created the partition.
CREATE OR REPLACE FUNCTION ensure_usage_events_partition(ts timestamptz)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  month_start timestamptz := date_trunc('month', ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  month_end timestamptz := month_start + interval '1 month';
  partition_name text := format('usage_events_y%sm%s',
    to_char(month_start AT TIME ZONE 'UTC', 'YYYY'),
    to_char(month_start AT TIME ZONE 'UTC', 'MM'));
BEGIN
  -- Serialise concurrent creators so CREATE TABLE IF NOT EXISTS cannot race on the catalog.
  PERFORM pg_advisory_xact_lock(hashtext('ensure_usage_events_partition'));
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_events FOR VALUES FROM (%L) TO (%L)',
    partition_name, month_start, month_end);
  RETURN partition_name;
END;
$$;
--> statement-breakpoint
SELECT ensure_usage_events_partition(now());
--> statement-breakpoint
SELECT ensure_usage_events_partition(now() + interval '1 month');
