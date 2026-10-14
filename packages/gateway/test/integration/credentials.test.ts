import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalKeyProvider } from '../../src/credentials/key-provider.js';
import {
  CredentialResolver,
  listCredentials,
  reencryptCredentials,
  setCredential,
} from '../../src/credentials/service.js';
import { createDb, createPool, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { auditLog, providerCredentials } from '../../src/db/schema.js';
import { createTenant, type Actor } from '../../src/tenancy/service.js';

const actor: Actor = { type: 'admin', id: 'admin@example.com' };
const v1 = randomBytes(32);
const v2 = randomBytes(32);
const keysV1 = new LocalKeyProvider(1, new Map([[1, v1]]));

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Db;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  await runMigrations(container.getConnectionUri());
  pool = createPool(container.getConnectionUri());
  db = createDb(pool);
  tenantA = (await createTenant(db, { slug: 'tenant-a', name: 'A' }, actor)).id;
  tenantB = (await createTenant(db, { slug: 'tenant-b', name: 'B' }, actor)).id;
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('provider credentials', () => {
  const anthropicSecret = 'sk-ant-api03-EXAMPLEEXAMPLEEXAMPLE-wxyz';

  it('store only ciphertext containing no substring of the original key', async () => {
    const { id } = await setCredential(
      db,
      keysV1,
      { tenantId: tenantA, provider: 'anthropic', label: 'prod', secret: anthropicSecret },
      actor,
    );
    const [row] = await db.select().from(providerCredentials).where(eq(providerCredentials.id, id));
    for (let i = 0; i + 5 <= anthropicSecret.length; i++) {
      const window = Buffer.from(anthropicSecret.slice(i, i + 5));
      for (const column of [row!.ciphertext, row!.wrappedDek, row!.iv, row!.authTag]) {
        expect(column.includes(window)).toBe(false);
      }
    }

    const dump = await container.exec([
      'pg_dump',
      '--data-only',
      '-U',
      container.getUsername(),
      container.getDatabase(),
    ]);
    expect(dump.output).not.toContain(anthropicSecret.slice(0, -4));
  });

  it('list only provider, label and the last 4 characters', async () => {
    const [listed] = (await listCredentials(db, tenantA)).filter((c) => c.provider === 'anthropic');
    expect(listed).toMatchObject({
      provider: 'anthropic',
      label: 'prod',
      last4: 'wxyz',
      scope: 'tenant',
    });
    expect(JSON.stringify(listed)).not.toContain(anthropicSecret.slice(0, -4));
    expect(Object.keys(listed!)).not.toEqual(expect.arrayContaining(['ciphertext']));
  });

  it('audit every change with the last 4 characters only', async () => {
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'provider_credential.set'));
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(anthropicSecret.slice(0, -4));
  });

  it('use the tenant-scoped credential over the platform default', async () => {
    await setCredential(
      db,
      keysV1,
      {
        tenantId: null,
        provider: 'anthropic',
        label: 'platform',
        secret: 'sk-platform-anthropic-0000',
      },
      actor,
    );
    const resolver = new CredentialResolver(db, keysV1);
    expect(await resolver.resolve(tenantA, 'anthropic')).toEqual({
      secret: anthropicSecret,
      baseUrl: null,
      scope: 'tenant',
    });
  });

  it('fall back to the platform default and report scope platform', async () => {
    const resolver = new CredentialResolver(db, keysV1);
    expect(await resolver.resolve(tenantB, 'anthropic')).toMatchObject({
      secret: 'sk-platform-anthropic-0000',
      scope: 'platform',
    });
    expect(await resolver.resolve(tenantB, 'gemini')).toBeNull();
  });

  it('replace an existing credential for the same tenant and provider', async () => {
    await setCredential(
      db,
      keysV1,
      {
        tenantId: tenantB,
        provider: 'local',
        label: 'ollama',
        secret: 'unused-local-key',
        baseUrl: 'http://ollama:11434/v1',
      },
      actor,
    );
    await setCredential(
      db,
      keysV1,
      {
        tenantId: tenantB,
        provider: 'local',
        label: 'ollama-2',
        secret: 'unused-local-key',
        baseUrl: 'http://ollama-2:11434/v1',
      },
      actor,
    );
    const rows = (await listCredentials(db, tenantB)).filter((c) => c.provider === 'local');
    expect(rows).toEqual([
      expect.objectContaining({ label: 'ollama-2', baseUrl: 'http://ollama-2:11434/v1' }),
    ]);
    expect(rows[0]!.rotatedAt).not.toBeNull();
  });

  it('decrypt every credential under the new key version after rotation and re-encrypt', async () => {
    const rotating = new LocalKeyProvider(
      2,
      new Map([
        [1, v1],
        [2, v2],
      ]),
    );
    const count = await reencryptCredentials(db, rotating);
    expect(count).toBeGreaterThan(0);
    expect(await reencryptCredentials(db, rotating)).toBe(0);

    const v2Only = new CredentialResolver(db, new LocalKeyProvider(2, new Map([[2, v2]])));
    expect((await v2Only.resolve(tenantA, 'anthropic'))?.secret).toBe(anthropicSecret);
    expect((await v2Only.resolve(tenantB, 'anthropic'))?.secret).toBe('sk-platform-anthropic-0000');
    const versions = await db
      .select({ v: providerCredentials.masterKeyVersion })
      .from(providerCredentials);
    expect(new Set(versions.map((r) => r.v))).toEqual(new Set([2]));
  });
});
