import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { buildApp } from '../../src/app.js';
import { createPool } from '../../src/db/client.js';
import { postgresCheck, redisCheck } from '../../src/readiness.js';
import { createRedis } from '../../src/redis.js';

let postgres: StartedPostgreSqlContainer;
let redisContainer: StartedRedisContainer;
let pool: pg.Pool;
let redis: Redis;
let app: FastifyInstance;

beforeAll(async () => {
  [postgres, redisContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);
  pool = createPool(postgres.getConnectionUri());
  redis = createRedis(redisContainer.getConnectionUrl());
  redis.on('error', () => {});
  await redis.connect();
  app = buildApp({
    logLevel: 'silent',
    readinessTimeoutMs: 1000,
    readinessChecks: { postgres: postgresCheck(pool), redis: redisCheck(redis) },
  });
});

afterAll(async () => {
  await app?.close();
  redis?.disconnect();
  await pool?.end();
  await postgres?.stop();
});

describe('readiness against real dependencies', () => {
  it('reports ready when postgres and redis are reachable', async () => {
    const res = await app.inject('/readyz');
    expect(res.statusCode).toBe(200);
  });

  it('reports redis as failing once redis stops, while liveness stays up', async () => {
    await redisContainer.stop();
    const ready = await app.inject('/readyz');
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({
      checks: { postgres: 'ok', redis: 'error' },
      failing: ['redis'],
    });
    expect((await app.inject('/healthz')).statusCode).toBe(200);
  });
});
