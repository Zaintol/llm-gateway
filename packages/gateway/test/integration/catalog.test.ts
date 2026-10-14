import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { asc, eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgCatalog } from '../../src/catalog/catalog.js';
import { loadCatalogFile, type CatalogDefinition } from '../../src/catalog/definition.js';
import { seedCatalog } from '../../src/catalog/seed.js';
import { createDb, createPool, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { modelPrices, models, usageEvents } from '../../src/db/schema.js';
import { insertUsageEvent } from '../../src/db/usage-events.js';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Db;
const catalog = loadCatalogFile();

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

const withPrice = (def: CatalogDefinition, id: string, output: number): CatalogDefinition => ({
  ...def,
  models: def.models.map((m) =>
    m.id === id ? { ...m, price: { ...m.price, output_per_mtok_usd: output } } : m,
  ),
});

const pricesFor = (id: string) =>
  db
    .select()
    .from(modelPrices)
    .where(eq(modelPrices.modelId, id))
    .orderBy(asc(modelPrices.effectiveFrom));

describe('catalog seeding', () => {
  it('loads every model with one open price, and is idempotent', async () => {
    const first = await seedCatalog(db, catalog);
    expect(first.pricesInserted).toBe(catalog.models.length);
    const second = await seedCatalog(db, catalog);
    expect(second).toMatchObject({ pricesInserted: 0, pricesClosed: 0, disabled: [] });
    expect((await pricesFor('openai/gpt-4o-mini'))[0]).toMatchObject({
      inputPricePerMtokMicros: 150_000n,
      outputPricePerMtokMicros: 600_000n,
      cachedInputPricePerMtokMicros: 75_000n,
      effectiveTo: null,
    });
  });

  it('inserts a new price row for a changed price, closes the old one, and leaves usage history pointing at the old row', async () => {
    const [oldPrice] = await pricesFor('mock/fast');
    const createdAt = new Date();
    await insertUsageEvent(db, {
      requestId: 'req_price_history',
      tenantId: '00000000-0000-4000-8000-000000000001',
      apiKeyId: '00000000-0000-4000-8000-000000000002',
      modelId: 'mock/fast',
      provider: 'mock',
      priceId: oldPrice!.id,
      costMicros: 42n,
      usageSource: 'provider',
      status: 'success',
      createdAt,
    });

    const report = await seedCatalog(db, withPrice(catalog, 'mock/fast', 0.3));
    expect(report).toMatchObject({ pricesInserted: 1, pricesClosed: 1 });

    const prices = await pricesFor('mock/fast');
    expect(prices).toHaveLength(2);
    expect(prices[0]).toMatchObject({ id: oldPrice!.id, outputPricePerMtokMicros: 200_000n });
    expect(prices[0]!.effectiveTo).toEqual(prices[1]!.effectiveFrom);
    expect(prices[1]).toMatchObject({ outputPricePerMtokMicros: 300_000n, effectiveTo: null });

    const [event] = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.requestId, 'req_price_history'));
    expect(event!.priceId).toBe(oldPrice!.id);
  });

  it('disables models removed from the file instead of deleting them', async () => {
    const report = await seedCatalog(db, {
      ...catalog,
      models: catalog.models.filter((m) => m.id !== 'mock/slow-3000'),
    });
    expect(report.disabled).toEqual(['mock/slow-3000']);
    const [row] = await db.select().from(models).where(eq(models.id, 'mock/slow-3000'));
    expect(row!.enabled).toBe(false);
    await seedCatalog(db, catalog);
  });

  it('serves current prices and policies through PgCatalog', async () => {
    const pgCatalog = new PgCatalog(db);
    expect(pgCatalog.ready).toBe(false);
    await pgCatalog.refresh();
    expect(pgCatalog.getModel('mock/fast')?.price?.outputPerMtokMicros).toBe(200_000n);
    expect(pgCatalog.getModel('local/llama3.2')?.price?.inputPerMtokMicros).toBe(0n);
    expect(pgCatalog.getPolicy('gw/cheap-fast')?.fallbackChain).toEqual([
      'mock/fast',
      'local/llama3.2',
    ]);
  });
});

describe('seed command', () => {
  it('exits non-zero naming a model without a price', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'catalog-'));
    const file = path.join(dir, 'models.yaml');
    writeFileSync(
      file,
      `models:
  - id: openai/unpriced
    upstream_model: unpriced
    context_window: 1000
    max_output_tokens: 100
    capabilities: {}
    quality_tier: 1
    latency_tier: fast
`,
    );
    const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const result = spawnSync(
      process.execPath,
      ['--conditions=@gw/source', '--import', 'tsx', 'src/catalog/seed.ts', file],
      {
        cwd: pkgRoot,
        env: { PATH: process.env.PATH, DATABASE_URL: container.getConnectionUri() },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('model "openai/unpriced" has no price');
  });
});
