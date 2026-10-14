import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { BudgetLedger } from '../../src/budget/ledger.js';
import { counterKey } from '../../src/budget/periods.js';
import {
  BudgetService,
  reconcileBudgets,
  type BudgetSource,
  type TenantBudgets,
} from '../../src/budget/service.js';
import { StaticCatalog } from '../../src/catalog/catalog.js';
import { chatRoutes } from '../../src/chat/route.js';
import { createDb, createPool, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { insertUsageEvent } from '../../src/db/usage-events.js';
import { ExecutionEngine } from '../../src/execution/engine.js';
import { ProviderError } from '../../src/providers/errors.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { createRedis } from '../../src/redis.js';
import { createTenant, setBudget } from '../../src/tenancy/service.js';
import {
  FakeAdapter,
  StaticCredentials,
  cannedResult,
  catalogModel,
  fakeAuth,
} from '../support/fakes.js';

const USD = 1_000_000n;
const TENANT = 'tenant_budget';

let redisContainer: StartedRedisContainer;
let redis: Redis;
let app: FastifyInstance;

beforeAll(async () => {
  redisContainer = await new RedisContainer('redis:7-alpine').start();
  redis = createRedis(redisContainer.getConnectionUrl());
  await redis.connect();
});
afterAll(async () => {
  redis?.disconnect();
  await redisContainer?.stop();
});
afterEach(async () => {
  await app?.close();
  await redis.flushall();
});

class StaticBudgets implements BudgetSource {
  constructor(private readonly budgets: Record<string, TenantBudgets>) {}
  async forTenant(tenantId: string) {
    return this.budgets[tenantId] ?? {};
  }
}

/** Prices chosen so worst case = max_tokens micro-USD: no input cost, $1 per million output tokens. */
const price = (outputUsdPerMtok: bigint) => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  effectiveFrom: new Date('2020-01-01T00:00:00Z'),
  effectiveTo: null,
  inputPerMtokMicros: 0n,
  outputPerMtokMicros: outputUsdPerMtok * USD,
  cachedInputPerMtokMicros: null,
});
const model = (id: string, outputUsdPerMtok: bigint) => {
  const p = price(outputUsdPerMtok);
  return catalogModel({
    id,
    provider: id.split('/')[0]!,
    upstreamModel: id.split('/')[1]!,
    contextWindow: 1_000_000,
    maxOutputTokens: 100_000,
    price: p,
    prices: [p],
  });
};
const catalog = new StaticCatalog(
  [model('cheap/m', 1n), model('pricey/m', 8n), model('flaky/m', 1n)],
  [
    {
      id: 'gw/cheap-then-pricey',
      description: '',
      requirements: {},
      fallbackChain: ['flaky/m', 'pricey/m'],
      enabled: true,
    },
  ],
);

/** Adapter that bills `outputTokens` after `delayMs`. */
const billing = (provider: string, outputTokens: number, delayMs = 0) =>
  new FakeAdapter(provider, async (req) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const result = cannedResult(req.model);
    return {
      ...result,
      usage: { inputTokens: 3, outputTokens, cachedInputTokens: 0, source: 'provider' as const },
    };
  });

function make(options: {
  budgets: Record<string, TenantBudgets>;
  adapters: FakeAdapter[];
  ledger?: BudgetLedger;
  tenantId?: string;
}) {
  const fakes = fakeAuth();
  const { key } = fakes.store.add({ tenantId: options.tenantId ?? TENANT });
  const ledger = options.ledger ?? new BudgetLedger(redis);
  app = buildApp({
    logLevel: 'silent',
    readinessChecks: {},
    readinessTimeoutMs: 100,
    auth: fakes.auth,
    dataPlaneRoutes: [
      chatRoutes({
        // Static chains: these tests exercise fallback order, not cost-aware routing.
        flags: { ff_cost_aware_routing: false },
        providers: new ProviderRegistry(options.adapters, catalog),
        catalog,
        credentials: new StaticCredentials(),
        engine: new ExecutionEngine({ sleep: async () => {}, maxRetries: 0 }),
        budgets: new BudgetService(ledger, new StaticBudgets(options.budgets)),
      }),
    ],
  });
  return (modelId: string, maxTokens: number) =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: {
        model: modelId,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
}

const dailyKey = (tenantId = TENANT) => counterKey(tenantId, 'daily', new Date());
const counter = async (key = dailyKey()) => BigInt((await redis.get(key)) ?? '0');
const dailyLimit = (usd: bigint) => ({
  [TENANT]: { daily: { hardLimitMicros: usd, softLimitMicros: null } },
});

describe('hard budgets (GW-5.2)', () => {
  it('returns 402 budget_exceeded without calling a provider when the worst case would exceed the limit', async () => {
    const adapter = billing('cheap', 10);
    const send = make({ budgets: dailyLimit(USD), adapters: [adapter] });
    await redis.set(dailyKey(), String((99n * USD) / 100n)); // 0.99 USD already spent
    const res = await send('cheap/m', 50_000); // worst case 0.05 USD
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toMatchObject({ type: 'budget_exceeded', code: 'budget_exceeded' });
    expect(res.json().error.message).toMatch(/Daily budget of \$1\.00 would be exceeded/);
    expect(adapter.calls).toHaveLength(0);
  });

  it('admits at most 20 of 50 concurrent 0.05 USD requests against a 1.00 USD limit', async () => {
    const adapter = billing('cheap', 50_000, 300); // actual cost == reservation, slow enough to overlap
    const send = make({ budgets: dailyLimit(USD), adapters: [adapter] });
    const results = await Promise.all(Array.from({ length: 50 }, () => send('cheap/m', 50_000)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(20);
    expect(results.filter((r) => r.statusCode === 402)).toHaveLength(30);
    await new Promise((r) => setTimeout(r, 100));
    expect(await counter()).toBe(USD);
  });

  it('settles the counter to prior spend plus the actual cost within 1 second', async () => {
    const send = make({ budgets: dailyLimit(USD), adapters: [billing('cheap', 7)] });
    await redis.set(dailyKey(), '1000');
    const res = await send('cheap/m', 50_000); // reserves 50,000 micro-USD, bills 7
    expect(res.statusCode).toBe(200);
    const settledBy = Date.now() + 1000;
    let value = await counter();
    while (value !== 1007n && Date.now() < settledBy) {
      await new Promise((r) => setTimeout(r, 10));
      value = await counter();
    }
    expect(value).toBe(1007n);
  });

  it('reserves the extra cost before falling back to a pricier model', async () => {
    const flaky = new FakeAdapter('flaky', () => {
      throw new ProviderError('provider_error', 'flaky', 'down');
    });
    const pricey = billing('pricey', 1_000);
    const send = make({ budgets: dailyLimit(USD / 10n), adapters: [flaky, pricey] });
    // Worst case: 0.01 USD on flaky/m, 0.08 USD on pricey/m. Both fit in 0.10 USD.
    const ok = await send('gw/cheap-then-pricey', 10_000);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['x-gateway-model']).toBe('pricey/m');
    await new Promise((r) => setTimeout(r, 100));
    expect(await counter()).toBe(8_000n); // settled to pricey's actual cost: 1,000 tokens x $8/Mtok

    // Worst case on pricey is now 0.16 USD: the fallback cannot be reserved, so the chain stops with 402.
    const blocked = await send('gw/cheap-then-pricey', 20_000);
    expect(blocked.statusCode).toBe(402);
  });

  it('releases the reservation when every attempt fails', async () => {
    const failing = new FakeAdapter('cheap', () => {
      throw new ProviderError('provider_error', 'cheap', 'down');
    });
    const send = make({ budgets: dailyLimit(USD), adapters: [failing] });
    expect((await send('cheap/m', 50_000)).statusCode).toBe(502);
    await new Promise((r) => setTimeout(r, 100));
    expect(await counter()).toBe(0n);
  });

  it('refunds a reservation abandoned by a crashed instance once its lease expires', async () => {
    const ledger = new BudgetLedger(redis, 50);
    const key = dailyKey();
    await ledger.reserve('req_crashed', 40_000n, [{ key, hardLimitMicros: USD, ttlSeconds: 3600 }]);
    expect(await counter()).toBe(40_000n);
    expect(await ledger.sweep()).toBe(0); // lease still valid
    await new Promise((r) => setTimeout(r, 80));
    expect(await ledger.sweep()).toBe(1);
    expect(await counter()).toBe(0n);
    // A late settle after the refund still records the true cost exactly once.
    await ledger.settle('req_crashed', 25_000n, [key]);
    expect(await counter()).toBe(25_000n);
  });

  it('fails closed with 503 for a tenant with a hard limit when Redis is down, and admits others', async () => {
    const dead = createRedis('redis://127.0.0.1:1');
    dead.on('error', () => {});
    const deadLedger = new BudgetLedger(dead);
    const limited = make({
      budgets: dailyLimit(USD),
      adapters: [billing('cheap', 1)],
      ledger: deadLedger,
    });
    const res = await limited('cheap/m', 100);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('budget_unavailable');
    await app.close();

    const unlimited = make({
      budgets: {},
      adapters: [billing('cheap', 1)],
      ledger: deadLedger,
      tenantId: 'tenant_free',
    });
    expect((await unlimited('cheap/m', 100)).statusCode).toBe(200);
    dead.disconnect();
  });
});

describe('reconciliation with Postgres', () => {
  let postgres: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let db: Db;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
    await runMigrations(postgres.getConnectionUri());
    pool = createPool(postgres.getConnectionUri());
    db = createDb(pool);
  });
  afterAll(async () => {
    await pool?.end();
    await postgres?.stop();
  });

  it('rebuilds drifted counters to the Postgres totals plus open reservations', async () => {
    const actor = { type: 'admin' as const, id: 'test' };
    const tenant = await createTenant(db, { slug: 'recon', name: 'Recon' }, actor);
    await setBudget(db, { tenantId: tenant.id, period: 'daily', hardLimitMicros: 5n * USD }, actor);
    await setBudget(
      db,
      { tenantId: tenant.id, period: 'monthly', hardLimitMicros: 50n * USD },
      actor,
    );
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86_400_000);
    for (const [i, [cost, at]] of (
      [
        [120_000n, now],
        [30_000n, now],
        [999_999n, yesterday],
      ] as const
    ).entries()) {
      await insertUsageEvent(db, {
        requestId: `req_recon_${i}`,
        tenantId: tenant.id,
        apiKeyId: '00000000-0000-4000-8000-000000000002',
        modelId: 'mock/fast',
        provider: 'mock',
        costMicros: cost,
        usageSource: 'provider',
        status: 'success',
        createdAt: at,
      });
    }
    const ledger = new BudgetLedger(redis);
    const daily = counterKey(tenant.id, 'daily', now);
    const monthly = counterKey(tenant.id, 'monthly', now);
    const reserved = await ledger.reserve('req_in_flight', 5_000n, [
      { key: daily, hardLimitMicros: 5n * USD, ttlSeconds: 3600 },
    ]);
    expect(reserved.ok).toBe(true);
    await redis.set(daily, '123456789'); // drift

    expect(await reconcileBudgets(db, ledger, now)).toBe(2);
    expect(await counter(daily)).toBe(150_000n + 5_000n);
    const sameMonth = yesterday.getUTCMonth() === now.getUTCMonth();
    expect(await counter(monthly)).toBe(150_000n + (sameMonth ? 999_999n : 0n));
  });
});
