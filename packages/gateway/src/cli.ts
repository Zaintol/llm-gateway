/**
 * Operator CLI for tenants and API keys until the admin API (GW-9.1) exists.
 *
 *   gw tenant:create <slug> <name>
 *   gw key:create <tenant-slug> <key-name> [--expires-in-days <n>]
 *   gw key:list <tenant-slug>
 *   gw key:revoke <tenant-slug> <key-prefix>
 */
import { userInfo } from 'node:os';
import { ConfigError, loadConfig } from './config.js';
import { createDb, createPool } from './db/client.js';
import { createRedis } from './redis.js';
import {
  createApiKey,
  createTenant,
  findTenantBySlug,
  listApiKeys,
  revokeApiKey,
  type Actor,
} from './tenancy/service.js';

const usage = `Usage:
  tenant:create <slug> <name>
  key:create <tenant-slug> <key-name> [--expires-in-days <n>]
  key:list <tenant-slug>
  key:revoke <tenant-slug> <key-prefix>`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

let config;
try {
  config = loadConfig();
} catch (err) {
  fail(err instanceof ConfigError ? err.message : String(err));
}

const [command, ...args] = process.argv.slice(2);
const actor: Actor = { type: 'admin', id: `cli:${userInfo().username}` };
const pool = createPool(config.DATABASE_URL);
const db = createDb(pool);

async function tenantId(slug: string | undefined): Promise<string> {
  if (!slug) fail(usage);
  const tenant = await findTenantBySlug(db, slug);
  if (!tenant) fail(`No tenant with slug "${slug}"`);
  return tenant.id;
}

try {
  switch (command) {
    case 'tenant:create': {
      const [slug, ...nameParts] = args;
      if (!slug || nameParts.length === 0) fail(usage);
      const tenant = await createTenant(db, { slug, name: nameParts.join(' ') }, actor);
      console.log(`Created tenant ${tenant.slug} (${tenant.id})`);
      break;
    }
    case 'key:create': {
      const [slug, name, flag, days] = args;
      if (!name) fail(usage);
      let expiresAt: Date | null = null;
      if (flag === '--expires-in-days') {
        const n = Number(days);
        if (!Number.isFinite(n) || n <= 0) fail('--expires-in-days must be a positive number');
        expiresAt = new Date(Date.now() + n * 86_400_000);
      }
      const created = await createApiKey(
        db,
        { tenantId: await tenantId(slug), name, expiresAt },
        actor,
      );
      console.log(`Created key "${created.name}" (prefix ${created.prefix}).`);
      console.log('Copy it now; it cannot be shown again:\n');
      console.log(created.key);
      break;
    }
    case 'key:list': {
      const keys = await listApiKeys(db, await tenantId(args[0]));
      console.table(
        keys.map((k) => ({
          prefix: k.prefix,
          name: k.name,
          created: k.createdAt.toISOString(),
          lastUsed: k.lastUsedAt?.toISOString() ?? '-',
          expires: k.expiresAt?.toISOString() ?? '-',
          revoked: k.revokedAt?.toISOString() ?? '-',
        })),
      );
      break;
    }
    case 'key:revoke': {
      const [slug, prefix] = args;
      if (!prefix) fail(usage);
      const redis = createRedis(config.REDIS_URL);
      await redis.connect();
      try {
        await revokeApiKey(db, redis, { tenantId: await tenantId(slug), prefix }, actor);
      } finally {
        redis.disconnect();
      }
      console.log(`Revoked key ${prefix}`);
      break;
    }
    default:
      fail(usage);
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  await pool.end();
}
