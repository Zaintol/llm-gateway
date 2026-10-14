import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { Authenticator } from '../../src/auth/authenticator.js';
import { RedisFailureLimiter } from '../../src/auth/failure-limiter.js';
import { subscribeToKeyInvalidations } from '../../src/auth/invalidation.js';
import { PgKeyStore } from '../../src/auth/key-store.js';
import { parseApiKey } from '../../src/auth/keys.js';
import { createDb, createPool, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { apiKeys, auditLog } from '../../src/db/schema.js';
import { createRedis, createSubscriber } from '../../src/redis.js';
import {
  createApiKey,
  createTenant,
  listApiKeys,
  revokeApiKey,
  type Actor,
} from '../../src/tenancy/service.js';

const actor: Actor = { type: 'admin', id: 'admin@example.com' };
const chatStub: FastifyPluginAsync = async (scope) => {
  scope.post('/chat/completions', async (request) => ({ tenantId: request.auth?.tenantId }));
};

let postgres: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let pool: pg.Pool;
let db: Db;
let redis: Redis;
let subscriber: Redis;
let app: FastifyInstance;
let tenantId: string;

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

  const authenticator = new Authenticator(new PgKeyStore(db));
  await subscribeToKeyInvalidations(subscriber, authenticator);
  app = buildApp({
    logLevel: 'silent',
    readinessChecks: {},
    readinessTimeoutMs: 1000,
    auth: { authenticator, failureLimiter: new RedisFailureLimiter(redis) },
    dataPlaneRoutes: [chatStub],
  });
  tenantId = (await createTenant(db, { slug: 'acme', name: 'Acme' }, actor)).id;
});

afterAll(async () => {
  await app?.close();
  redis?.disconnect();
  subscriber?.disconnect();
  await pool?.end();
  await Promise.all([postgres?.stop(), redisContainer?.stop()]);
});

const chat = (key: string, ip = '10.1.0.1') =>
  app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    remoteAddress: ip,
    headers: { authorization: `Bearer ${key}` },
  });

describe('api key lifecycle', () => {
  it('returns the full key once at creation; listing shows only prefix and name', async () => {
    const created = await createApiKey(db, { tenantId, name: 'billing-service' }, actor);
    expect(created.key).toMatch(new RegExp(`^gw_live_${created.prefix}_[0-9A-Za-z]{43}$`));

    const listed = await listApiKeys(db, tenantId);
    const entry = listed.find((k) => k.id === created.id)!;
    expect(entry).toMatchObject({ name: 'billing-service', prefix: created.prefix });
    expect(JSON.stringify(listed)).not.toContain(parseApiKey(created.key)!.secret);
    expect(Object.keys(entry)).not.toContain('key');
    expect(Object.keys(entry)).not.toContain('secretHash');
  });

  it('authenticates a new key against the database', async () => {
    const { key } = await createApiKey(db, { tenantId, name: 'web' }, actor);
    const res = await chat(key);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId });
  });

  it('rejects a revoked key within 2 seconds, even while cached', async () => {
    const { key, prefix } = await createApiKey(db, { tenantId, name: 'to-revoke' }, actor);
    expect((await chat(key)).statusCode).toBe(200); // warms the auth cache

    const revokedAt = Date.now();
    await revokeApiKey(db, redis, { tenantId, prefix }, actor);
    let status = 200;
    while (Date.now() - revokedAt < 2000) {
      status = (await chat(key)).statusCode;
      if (status === 401) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(status).toBe(401);
  });

  it('rejects an expired key with key_expired', async () => {
    const { key, id } = await createApiKey(db, { tenantId, name: 'short-lived' }, actor);
    await db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeys.id, id));
    const res = await chat(key, '10.1.0.2');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('key_expired');
  });

  it('writes audit rows with actor, action, key prefix and timestamp', async () => {
    const before = new Date();
    const { prefix, id } = await createApiKey(db, { tenantId, name: 'audited' }, actor);
    await revokeApiKey(db, redis, { tenantId, prefix }, actor);

    const rows = await db.select().from(auditLog).where(eq(auditLog.targetId, id));
    expect(rows.map((r) => r.action).sort()).toEqual(['api_key.create', 'api_key.revoke']);
    for (const row of rows) {
      expect(row).toMatchObject({ actorType: 'admin', actorId: actor.id, tenantId });
      expect(row.metadata).toMatchObject({ prefix });
      expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    }
  });

  it('refuses to revoke a key that is already revoked', async () => {
    const { prefix } = await createApiKey(db, { tenantId, name: 'once' }, actor);
    await revokeApiKey(db, redis, { tenantId, prefix }, actor);
    await expect(revokeApiKey(db, redis, { tenantId, prefix }, actor)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('leaves no plaintext key secret anywhere in a database dump', async () => {
    const secrets = await Promise.all(
      ['dump-a', 'dump-b'].map(async (name) => {
        const { key } = await createApiKey(db, { tenantId, name }, actor);
        return parseApiKey(key)!.secret;
      }),
    );
    const dump = await postgres.exec([
      'pg_dump',
      '--data-only',
      '-U',
      postgres.getUsername(),
      postgres.getDatabase(),
    ]);
    expect(dump.exitCode).toBe(0);
    expect(dump.output).toContain('dump-a');
    for (const secret of secrets) expect(dump.output).not.toContain(secret);
  });
});

describe('auth failure limiter on redis', () => {
  it('blocks an IP after 20 failures in a window', async () => {
    const limiter = new RedisFailureLimiter(redis);
    const ip = '203.0.113.7';
    for (let i = 0; i < 19; i++) await limiter.recordFailure(ip);
    expect(await limiter.isBlocked(ip)).toBe(false);
    await limiter.recordFailure(ip);
    expect(await limiter.isBlocked(ip)).toBe(true);
    expect(await limiter.isBlocked('203.0.113.8')).toBe(false);
  });
});
