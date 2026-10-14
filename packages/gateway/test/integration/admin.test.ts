import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { Validator } from '@seriousme/openapi-schema-validator';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminAuthenticator, createAdminToken, mintAdminJwt } from '../../src/admin/auth.js';
import { subscribeToInvalidations } from '../../src/admin/invalidation.js';
import { adminRoutes, type AdminDeps } from '../../src/admin/routes.js';
import { buildApp } from '../../src/app.js';
import { Authenticator } from '../../src/auth/authenticator.js';
import { RedisFailureLimiter } from '../../src/auth/failure-limiter.js';
import { subscribeToKeyInvalidations } from '../../src/auth/invalidation.js';
import { PgKeyStore } from '../../src/auth/key-store.js';
import { BudgetLedger } from '../../src/budget/ledger.js';
import { BudgetService, PgBudgetSource } from '../../src/budget/service.js';
import { StaticCatalog } from '../../src/catalog/catalog.js';
import { chatRoutes } from '../../src/chat/route.js';
import { LocalKeyProvider } from '../../src/credentials/key-provider.js';
import { createDb, createPool, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { auditLog, providerCredentials } from '../../src/db/schema.js';
import { insertUsageEvent } from '../../src/db/usage-events.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { createRedis, createSubscriber } from '../../src/redis.js';
import { createApiKey, createTenant } from '../../src/tenancy/service.js';
import { FakeAdapter, StaticCredentials, cannedResult, catalogModel } from '../support/fakes.js';

const SECRET = 'test-admin-jwt-secret-0123456789abcdef';
const system = { type: 'system' as const, id: 'test' };

let postgres: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let pool: pg.Pool;
let db: Db;
let redis: Redis;
let subscriber: Redis;
let app: FastifyInstance;
let deps: AdminDeps;
let acme: string;
let globex: string;
let acmeKey: string;

beforeAll(async () => {
  [postgres, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);
  await runMigrations(postgres.getConnectionUri());
  pool = createPool(postgres.getConnectionUri());
  db = createDb(pool);
  redis = createRedis(redisContainer.getConnectionUrl());
  subscriber = createSubscriber(redisContainer.getConnectionUrl());
  await Promise.all([redis.connect(), subscriber.connect()]);

  acme = (await createTenant(db, { slug: 'acme', name: 'Acme' }, system)).id;
  globex = (await createTenant(db, { slug: 'globex', name: 'Globex' }, system)).id;
  acmeKey = (await createApiKey(db, { tenantId: acme, name: 'app' }, system)).key;

  const catalog = new StaticCatalog([catalogModel()]);
  deps = {
    db,
    redis,
    keys: new LocalKeyProvider(1, new Map([[1, randomBytes(32)]])),
    catalog,
    authenticator: new AdminAuthenticator(db, SECRET),
  };
  const authenticator = new Authenticator(new PgKeyStore(db));
  const budgetSource = new PgBudgetSource(db);
  await subscribeToKeyInvalidations(subscriber, authenticator);
  await subscribeToInvalidations(subscriber, {
    budgets: (tenantId) => budgetSource.invalidate(tenantId),
  });
  app = buildApp({
    logLevel: 'silent',
    readinessChecks: {},
    readinessTimeoutMs: 100,
    auth: { authenticator, failureLimiter: new RedisFailureLimiter(redis) },
    admin: { deps, routes: adminRoutes(deps), version: 'test' },
    dataPlaneRoutes: [
      chatRoutes({
        providers: new ProviderRegistry(
          [new FakeAdapter('mock', (req) => cannedResult(req.model))],
          catalog,
        ),
        catalog,
        credentials: new StaticCredentials(),
        budgets: new BudgetService(new BudgetLedger(redis), budgetSource),
      }),
    ],
  });
});

afterAll(async () => {
  await app?.close();
  redis?.disconnect();
  subscriber?.disconnect();
  await pool?.end();
  await Promise.all([postgres?.stop(), redisContainer?.stop()]);
});

const jwt = (
  role: 'platform_admin' | 'tenant_admin' | 'finance_viewer',
  tenantId: string | null,
  ttl = 900,
) => mintAdminJwt(SECRET, { subject: `${role}@example.com`, role, tenantId }, ttl);

const admin = async (
  token: string,
  method: string,
  url: string,
  payload?: object,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method: method as 'GET',
    url: `/admin/v1${url}`,
    headers: { authorization: `Bearer ${token}`, ...headers },
    ...(payload ? { payload } : {}),
  });

const chat = () =>
  app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${acmeKey}` },
    payload: { model: 'mock/fast', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] },
  });

describe('admin API (GW-9.1)', () => {
  it('applies a budget set by a tenant admin to the very next data-plane request', async () => {
    expect((await chat()).statusCode).toBe(200); // warms the tenant's cached (empty) budgets
    const token = await jwt('tenant_admin', acme);

    const set = await admin(token, 'PUT', `/tenants/${acme}/budgets`, {
      period: 'monthly',
      hard_limit_usd: 50,
    });
    expect(set.statusCode).toBe(200);
    expect((await admin(token, 'GET', `/tenants/${acme}/budgets`)).json().data).toEqual([
      { period: 'monthly', hard_limit_usd: 50, soft_limit_usd: null },
    ]);

    // Shrink it below one request's worst case: the next request must be refused.
    await admin(token, 'PUT', `/tenants/${acme}/budgets`, {
      period: 'monthly',
      hard_limit_usd: 0.000001,
    });
    await new Promise((r) => setTimeout(r, 100)); // pub/sub delivery
    const blocked = await chat();
    expect(blocked.statusCode).toBe(402);

    await admin(token, 'PUT', `/tenants/${acme}/budgets`, {
      period: 'monthly',
      hard_limit_usd: null,
    });
  });

  it('returns 403 when a finance viewer lists API keys', async () => {
    const res = await admin(await jwt('finance_viewer', acme), 'GET', `/tenants/${acme}/keys`);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('role_forbidden');
  });

  it('lets a finance viewer read budgets and usage', async () => {
    const token = await jwt('finance_viewer', acme);
    expect((await admin(token, 'GET', `/tenants/${acme}/budgets`)).statusCode).toBe(200);
  });

  it('returns 401 on every admin route for an expired token', async () => {
    const expired = await jwt('platform_admin', null, -10);
    for (const route of adminRoutes(deps)) {
      const url = route.url
        .replace(':id', acme)
        .replace(':prefix', 'ABCDEFGH')
        .replace(':provider', 'openai');
      const res = await admin(
        expired,
        route.method,
        url,
        route.method === 'GET' || route.method === 'DELETE' ? undefined : {},
      );
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect(res.json().error.code).toBe('admin_token_expired');
    }
  });

  it('records actor, role, route, target and time for mutating calls', async () => {
    const before = new Date();
    const res = await admin(await jwt('tenant_admin', acme), 'POST', `/tenants/${acme}/keys`, {
      name: 'ci-bot',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().key).toMatch(/^gw_live_/);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'api_key.create'), eq(auditLog.targetId, res.json().id)));
    expect(row).toMatchObject({
      actorType: 'admin',
      actorId: 'tenant_admin@example.com',
      tenantId: acme,
      metadata: expect.objectContaining({
        role: 'tenant_admin',
        route: 'POST /tenants/:id/keys',
        prefix: res.json().prefix,
      }),
    });
    expect(row!.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it('serves an OpenAPI 3.1 document that validates and lists every admin route', async () => {
    const res = await app.inject('/admin/v1/openapi.json');
    expect(res.statusCode).toBe(200);
    const document = res.json();
    const result = await new Validator().validate(document);
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
    expect(document.openapi).toBe('3.1.0');
    for (const route of adminRoutes(deps)) {
      const path = `/admin/v1${route.url.replace(/:([a-z_]+)/g, '{$1}')}`;
      expect(
        document.paths[path]?.[route.method.toLowerCase()],
        `${route.method} ${path}`,
      ).toBeDefined();
    }
  });
});

describe('admin authorisation', () => {
  it('confines tenant admins to their own tenant', async () => {
    const token = await jwt('tenant_admin', acme);
    expect((await admin(token, 'GET', `/tenants/${globex}/keys`)).statusCode).toBe(403);
    expect((await admin(token, 'GET', '/tenants')).statusCode).toBe(403);
    expect((await admin(token, 'GET', `/tenants/${acme}`)).statusCode).toBe(200);
  });

  it('lets platform admins manage any tenant', async () => {
    const token = await jwt('platform_admin', null);
    expect(
      (await admin(token, 'GET', '/tenants')).json().data.map((t: { slug: string }) => t.slug),
    ).toEqual(['acme', 'globex']);
    const created = await admin(token, 'POST', '/tenants', { slug: 'initech', name: 'Initech' });
    expect(created.statusCode).toBe(201);
    expect((await admin(token, 'GET', `/tenants/${globex}/keys`)).statusCode).toBe(200);
  });

  it('accepts service tokens and rejects them once revoked', async () => {
    const { token, prefix } = await createAdminToken(
      db,
      { name: 'terraform', role: 'tenant_admin', tenantId: acme },
      system,
    );
    expect((await admin(token, 'GET', '/me')).json()).toEqual({
      subject: 'token:terraform',
      role: 'tenant_admin',
      tenant_id: acme,
    });
    await pool.query('update admin_tokens set revoked_at = now() where prefix = $1', [prefix]);
    deps.authenticator.invalidate(prefix);
    expect((await admin(token, 'GET', '/me')).statusCode).toBe(401);
  });

  it('rejects tokens signed with another secret and data-plane keys', async () => {
    const forged = await mintAdminJwt('another-secret-that-is-long-enough-123', {
      subject: 'x',
      role: 'platform_admin',
      tenantId: null,
    });
    expect((await admin(forged, 'GET', '/me')).statusCode).toBe(401);
    expect((await admin(acmeKey, 'GET', '/me')).statusCode).toBe(403);
  });

  it('stores credentials encrypted and only ever returns the last 4 characters', async () => {
    const token = await jwt('tenant_admin', acme);
    const secret = 'sk-ant-api03-ADMIN-API-TEST-SECRET-9z9z';
    const res = await admin(token, 'PUT', `/tenants/${acme}/credentials/anthropic`, {
      label: 'prod',
      secret,
    });
    expect(res.json()).toEqual({ provider: 'anthropic', label: 'prod', last4: '9z9z' });
    const listed = await admin(token, 'GET', `/tenants/${acme}/credentials`);
    expect(JSON.stringify(listed.json())).not.toContain(secret.slice(0, -4));
    const [row] = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.tenantId, acme));
    expect(row!.ciphertext.includes(Buffer.from(secret))).toBe(false);
  });
});

describe('usage query', () => {
  beforeAll(async () => {
    const day = (d: number, h = 12) => new Date(Date.UTC(2026, 9, d, h));
    const events: Array<[string, string, string, bigint, Date]> = [
      [acme, 'mock/fast', 'success', 1_000n, day(10)],
      [acme, 'mock/fast', 'success', 2_000n, day(10, 15)],
      [acme, 'mock/smart', 'error', 0n, day(11)],
      [globex, 'mock/fast', 'success', 9_000n, day(10)],
    ];
    for (const [i, [tenantId, modelId, status, cost, createdAt]] of events.entries()) {
      await insertUsageEvent(db, {
        requestId: `req_usage_${i}`,
        tenantId,
        apiKeyId: '00000000-0000-4000-8000-000000000002',
        modelId,
        provider: 'mock',
        inputTokens: 10,
        outputTokens: 5,
        costMicros: cost,
        usageSource: status === 'error' ? 'none' : 'provider',
        status: status as 'success',
        createdAt,
      });
    }
  });
  const range = 'from=2026-10-09T00:00:00Z&to=2026-10-12T00:00:00Z';

  it('groups a tenant admin’s own usage by day and model', async () => {
    const res = await admin(
      await jwt('tenant_admin', acme),
      'GET',
      `/usage?${range}&group_by=day,model`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      {
        period: '2026-10-10T00:00:00Z',
        model: 'mock/fast',
        requests: 2,
        errors: 0,
        fallbacks: 0,
        input_tokens: 20,
        output_tokens: 10,
        cost_usd: 0.003,
      },
      {
        period: '2026-10-11T00:00:00Z',
        model: 'mock/smart',
        requests: 1,
        errors: 1,
        fallbacks: 0,
        input_tokens: 10,
        output_tokens: 5,
        cost_usd: 0,
      },
    ]);
  });

  it('forbids a tenant admin from querying another tenant', async () => {
    const res = await admin(
      await jwt('tenant_admin', acme),
      'GET',
      `/usage?${range}&tenant_id=${globex}`,
    );
    expect(res.statusCode).toBe(403);
  });

  it('lets platform admins group across tenants', async () => {
    const res = await admin(
      await jwt('platform_admin', null),
      'GET',
      `/usage?${range}&group_by=tenant`,
    );
    expect(
      res
        .json()
        .data.map((r: { tenant_id: string; cost_usd: number }) => [r.tenant_id, r.cost_usd])
        .sort(),
    ).toEqual(
      [
        [acme, 0.003],
        [globex, 0.009],
      ].sort(),
    );
  });

  it('rejects ranges above the maximum, naming it', async () => {
    const res = await admin(
      await jwt('tenant_admin', acme),
      'GET',
      '/usage?from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z',
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('The maximum range is 31 days');
  });

  it('returns CSV with a header row matching the JSON field names', async () => {
    const res = await admin(
      await jwt('finance_viewer', acme),
      'GET',
      `/usage?${range}&group_by=model`,
      undefined,
      { accept: 'text/csv' },
    );
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const [header, ...rows] = res.body.trim().split('\n');
    expect(header).toBe('model,requests,errors,fallbacks,input_tokens,output_tokens,cost_usd');
    expect(rows).toEqual(['mock/fast,2,0,0,20,10,0.003', 'mock/smart,1,1,0,10,5,0']);
  });
});
