import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createDb, createPool, type Db } from '../../src/db/client.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { migrationsFolder, runMigrations } from '../../src/db/migrate.js';
import { insertUsageEvent, type NewUsageEvent } from '../../src/db/usage-events.js';

const expectedTables = [
  'api_keys',
  'audit_log',
  'budgets',
  'model_prices',
  'models',
  'provider_credentials',
  'routing_policies',
  'tenant_settings',
  'tenants',
  'usage_events',
  'usage_rollups_hourly',
];

const migrationFiles = (
  JSON.parse(readFileSync(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
    entries: unknown[];
  }
).entries.length;

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Db;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  await runMigrations(container.getConnectionUri());
  pool = createPool(container.getConnectionUri());
  db = createDb(pool);
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

const journalCount = async () =>
  Number(
    (await pool.query('select count(*) from drizzle.__drizzle_migrations')).rows[0].count as string,
  );

function usageEvent(overrides: Partial<NewUsageEvent> = {}): NewUsageEvent {
  return {
    requestId: `req_${Math.random().toString(36).slice(2)}`,
    tenantId: '00000000-0000-4000-8000-000000000001',
    apiKeyId: '00000000-0000-4000-8000-000000000002',
    modelId: 'mock/fast',
    provider: 'mock',
    inputTokens: 10,
    outputTokens: 20,
    costMicros: 1_250n,
    usageSource: 'provider',
    status: 'success',
    ...overrides,
  };
}

describe('migrations', () => {
  it('create every core table and record each migration in the journal', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type in ('BASE TABLE')
         and table_name not like 'usage_events_y%'
       union
       select relname from pg_class where relkind = 'p' and relname = 'usage_events'
       order by 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(expectedTables);
    expect(await journalCount()).toBe(migrationFiles);
  });

  it('apply no changes when run against an already migrated database', async () => {
    const before = await journalCount();
    await expect(runMigrations(container.getConnectionUri())).resolves.toBeUndefined();
    expect(await journalCount()).toBe(before);
  });

  it('pre-create partitions for the current and next month', async () => {
    const { rows } = await pool.query<{ relname: string }>(
      `select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
       where i.inhparent = 'usage_events'::regclass order by 1`,
    );
    expect(rows).toHaveLength(2);
  });
});

describe('usage_events partitioning', () => {
  it('stores a row for a month without a partition in a newly created partition for that month', async () => {
    const createdAt = new Date('2031-05-17T12:00:00Z');
    await insertUsageEvent(db, usageEvent({ createdAt }));

    const { rows } = await pool.query<{ partition: string }>(
      `select tableoid::regclass::text as partition from usage_events where created_at = $1`,
      [createdAt],
    );
    expect(rows).toEqual([{ partition: 'usage_events_y2031m05' }]);
  });

  it('places rows on a month boundary by UTC month', async () => {
    const createdAt = new Date('2031-07-01T00:00:00Z');
    await insertUsageEvent(db, usageEvent({ createdAt }));
    const { rows } = await pool.query(
      `select tableoid::regclass::text as partition from usage_events where created_at = $1`,
      [createdAt],
    );
    expect(rows[0].partition).toBe('usage_events_y2031m07');
  });

  it('creates the partition once when concurrent inserts hit the same new month', async () => {
    const createdAt = new Date('2032-02-10T08:00:00Z');
    await Promise.all(
      Array.from({ length: 10 }, () => insertUsageEvent(db, usageEvent({ createdAt }))),
    );
    const { rows } = await pool.query(
      `select count(*)::int as n from usage_events_y2032m02 where created_at = $1`,
      [createdAt],
    );
    expect(rows[0].n).toBe(10);
  });

  it('ignores a second insert of the same request id (idempotent writes)', async () => {
    const event = usageEvent({ createdAt: new Date('2031-05-18T00:00:00Z') });
    await insertUsageEvent(db, event);
    await insertUsageEvent(db, event);
    const { rows } = await pool.query(
      `select count(*)::int as n from usage_events where request_id = $1`,
      [event.requestId],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('money columns', () => {
  it('reject a fractional micro-USD amount', async () => {
    await expect(
      pool.query(
        `insert into usage_events (request_id, tenant_id, api_key_id, model_id, provider,
           cost_micros, usage_source, status)
         values ('req_frac', $1, $1, 'mock/fast', 'mock', $2, 'provider', 'success')`,
        ['00000000-0000-4000-8000-000000000001', '1.5'],
      ),
    ).rejects.toThrow(/invalid input syntax for type bigint/);
  });

  it('reject a negative price', async () => {
    await pool.query(
      `insert into models (id, provider, upstream_model_name, context_window, max_output_tokens,
         quality_tier, latency_tier) values ('mock/neg', 'mock', 'neg', 8000, 1000, 1, 'fast')`,
    );
    await expect(
      pool.query(
        `insert into model_prices (model_id, input_price_per_mtok_micros, output_price_per_mtok_micros,
           effective_from, source_url) values ('mock/neg', -1, 0, now(), 'https://example.com')`,
      ),
    ).rejects.toThrow(/model_prices_non_negative_check/);
  });

  it('allow only one open price per model', async () => {
    await pool.query(
      `insert into models (id, provider, upstream_model_name, context_window, max_output_tokens,
         quality_tier, latency_tier) values ('mock/one', 'mock', 'one', 8000, 1000, 1, 'fast')`,
    );
    const insertOpenPrice = () =>
      pool.query(
        `insert into model_prices (model_id, input_price_per_mtok_micros, output_price_per_mtok_micros,
           effective_from, source_url) values ('mock/one', 150000, 600000, now(), 'https://example.com')`,
      );
    await insertOpenPrice();
    await expect(insertOpenPrice()).rejects.toThrow(/model_prices_one_open_price_uq/);
  });
});
