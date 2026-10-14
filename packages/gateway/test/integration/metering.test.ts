import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp as buildMockProvider } from '@gw/mock-provider';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { Queue, Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { chatRoutes } from '../../src/chat/route.js';
import { createDb, createPool, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { usageEvents } from '../../src/db/schema.js';
import type { UsageEvent } from '../../src/metering/event.js';
import { createUsageQueue, redisConnection } from '../../src/metering/queue.js';
import { QueueUsageRecorder } from '../../src/metering/recorder.js';
import { SpillFile } from '../../src/metering/spill.js';
import { persistUsageEvent, startUsageWorker } from '../../src/metering/worker.js';
import { OpenAiCompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { StaticCredentials, fakeAuth } from '../support/fakes.js';

const TENANT = '00000000-0000-4000-8000-0000000000aa';
const KEY = '00000000-0000-4000-8000-0000000000bb';
const silent = { warn: () => {}, error: () => {} };

let postgres: StartedPostgreSqlContainer;
let redis: StartedRedisContainer;
let pool: pg.Pool;
let db: Db;
let queue: Queue<UsageEvent>;
let worker: Worker<UsageEvent>;
/** requestId -> how many more times the worker should fail it (simulated database outage). */
const failuresToInject = new Map<string, number>();

beforeAll(async () => {
  [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);
  await runMigrations(postgres.getConnectionUri());
  pool = createPool(postgres.getConnectionUri());
  db = createDb(pool);
  queue = createUsageQueue(redis.getConnectionUrl(), { attempts: 5, backoffMs: 100 });
  worker = startUsageWorker({
    db,
    connection: redisConnection(redis.getConnectionUrl(), { maxRetriesPerRequest: null }),
    log: silent,
    persist: async (data) => {
      const id = (data as UsageEvent).requestId;
      const remaining = failuresToInject.get(id) ?? 0;
      if (remaining > 0) {
        failuresToInject.set(id, remaining - 1);
        throw new Error('connection terminated unexpectedly (simulated outage)');
      }
      await persistUsageEvent(db, data);
    },
  });
});

afterAll(async () => {
  await worker?.close();
  await queue?.close();
  await pool?.end();
  await Promise.all([postgres?.stop(), redis?.stop()]);
});

function event(requestId: string, overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    requestId,
    tenantId: TENANT,
    apiKeyId: KEY,
    requestedModel: 'mock/fast',
    modelId: 'mock/fast',
    provider: 'mock',
    priceId: null,
    credentialScope: null,
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: 0,
    costMicros: '3',
    usageSource: 'provider',
    status: 'success',
    attempts: 1,
    fallbackUsed: false,
    latencyMs: 12,
    ttftMs: null,
    routeReason: 'concrete',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const rowsFor = (requestId: string) =>
  db.select().from(usageEvents).where(eq(usageEvents.requestId, requestId));

async function waitForRow(requestId: string, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const rows = await rowsFor(requestId);
    if (rows.length) return { rows, elapsed: Date.now() - started };
    await new Promise((r) => setTimeout(r, 50));
  }
  return { rows: [], elapsed: Date.now() - started };
}

const spillFile = () =>
  new SpillFile(path.join(mkdtempSync(path.join(tmpdir(), 'spill-')), 'usage.ndjson'));

describe('usage event persistence (GW-7.2)', () => {
  it('writes a usage row within 5 seconds of a completed request', async () => {
    const recorder = new QueueUsageRecorder(queue, spillFile(), silent);
    recorder.record(event('req_fast_path', { costMicros: '450' }));
    const { rows, elapsed } = await waitForRow('req_fast_path');
    expect(elapsed).toBeLessThan(5000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId: TENANT, costMicros: 450n, status: 'success' });
  });

  it('keeps exactly one row when the same event is processed twice', async () => {
    const e = event('req_twice');
    await persistUsageEvent(db, e);
    await persistUsageEvent(db, e);
    await queue.add('usage', e, { jobId: 'req_twice_redelivered' });
    await new Promise((r) => setTimeout(r, 500));
    expect(await rowsFor('req_twice')).toHaveLength(1);
  });

  it('persists every event once the database recovers, leaving the dead-letter queue empty', async () => {
    const ids = ['req_outage_1', 'req_outage_2', 'req_outage_3'];
    for (const id of ids) failuresToInject.set(id, 3);
    const recorder = new QueueUsageRecorder(queue, spillFile(), silent);
    for (const id of ids) recorder.record(event(id));
    for (const id of ids) expect((await waitForRow(id, 10_000)).rows).toHaveLength(1);
    expect(await queue.getFailedCount()).toBe(0);
  });

  it('spills events while Redis is unreachable and persists them after replay', async () => {
    const spill = spillFile();
    const deadQueue = createUsageQueue('redis://127.0.0.1:1', { attempts: 5, backoffMs: 100 });
    deadQueue.on('error', () => {});
    const down = new QueueUsageRecorder(deadQueue, spill, silent, 500);
    down.record(event('req_spilled'));
    await down.flush();
    await deadQueue.close().catch(() => {});
    expect(await spill.size()).toBeGreaterThan(0);
    expect(await rowsFor('req_spilled')).toHaveLength(0);

    // "Restart" with Redis available: the gateway replays the spill file on startup.
    const restarted = new QueueUsageRecorder(queue, spill, silent);
    expect(await restarted.replaySpill()).toBe(1);
    expect((await waitForRow('req_spilled')).rows).toHaveLength(1);
    expect(await spill.size()).toBe(0);
  });
});

describe('metered requests end to end', () => {
  let upstream: FastifyInstance;
  let gateway: FastifyInstance;
  let apiKey: string;

  beforeAll(async () => {
    upstream = buildMockProvider({ logLevel: 'silent' });
    const upstreamUrl = await upstream.listen({ host: '127.0.0.1', port: 0 });
    const fakes = fakeAuth();
    gateway = buildApp({
      logLevel: 'silent',
      readinessChecks: {},
      readinessTimeoutMs: 100,
      auth: fakes.auth,
      dataPlaneRoutes: [
        chatRoutes({
          providers: new ProviderRegistry([
            new OpenAiCompatibleAdapter({
              provider: 'mock',
              defaultBaseUrl: `${upstreamUrl}/v1`,
              requiresCredential: false,
            }),
          ]),
          credentials: new StaticCredentials(),
          usage: new QueueUsageRecorder(queue, spillFile(), silent),
        }),
      ],
    });
    apiKey = fakes.store.add({ keyId: KEY, tenantId: TENANT }).key;
  });

  afterAll(async () => {
    await gateway?.close();
    await upstream?.close();
  });

  it('stores counts and identifiers but never prompt or completion text', async () => {
    const marker = 'CONFIDENTIAL-PROMPT-7f3a';
    const res = await gateway.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { model: 'mock/fast', messages: [{ role: 'user', content: marker }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toContain(marker);

    const { rows } = await waitForRow(res.headers['x-request-id'] as string);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'success',
      usageSource: 'provider',
      modelId: 'mock/fast',
    });
    expect(rows[0]!.inputTokens).toBeGreaterThan(0);
    expect(
      JSON.stringify(rows[0], (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    ).not.toContain(marker);
  });
});
