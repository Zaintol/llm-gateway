/**
 * Operator CLI for tenants and API keys until the admin API (GW-9.1) exists.
 *
 *   gw tenant:create <slug> <name>
 *   gw key:create <tenant-slug> <key-name> [--expires-in-days <n>]
 *   gw key:list <tenant-slug>
 *   gw key:revoke <tenant-slug> <key-prefix>
 *   gw credential:set <tenant-slug|--platform> <provider> <label> [--base-url <url>]  (secret on stdin)
 *   gw credential:list <tenant-slug|--platform>
 *   gw credentials:reencrypt
 *   gw limits:set <tenant-slug> [--key <prefix>] [--rpm <n|none>] [--tpm <n|none>]
 *   gw budget:set <tenant-slug> <daily|monthly> [--hard <usd|none>] [--soft <usd|none>]
 *   gw admin-token:create <name> --role <role> [--tenant <slug>]
 *   gw admin-jwt:mint --role <role> [--tenant <slug>] [--subject <email>] [--ttl <seconds>]
 *   gw demo:seed [--days <n>]
 */
import { userInfo } from 'node:os';
import { ConfigError, loadConfig } from './config.js';
import { createDb, createPool } from './db/client.js';
import {
  keyProviderFromConfig,
  listCredentials,
  reencryptCredentials,
  setCredential,
} from './credentials/service.js';
import { createAdminToken, mintAdminJwt } from './admin/auth.js';
import { seedDemo } from './demo/seed.js';
import { createRedis } from './redis.js';
import {
  createApiKey,
  createTenant,
  findTenantBySlug,
  listApiKeys,
  revokeApiKey,
  setBudget,
  setRateLimits,
  type Actor,
  type AdminRole,
} from './tenancy/service.js';

const usage = `Usage:
  tenant:create <slug> <name>
  key:create <tenant-slug> <key-name> [--expires-in-days <n>]
  key:list <tenant-slug>
  key:revoke <tenant-slug> <key-prefix>
  credential:set <tenant-slug|--platform> <provider> <label> [--base-url <url>]   (secret on stdin)
  credential:list <tenant-slug|--platform>
  credentials:reencrypt
  limits:set <tenant-slug> [--key <prefix>] [--rpm <n|none>] [--tpm <n|none>]
  budget:set <tenant-slug> <daily|monthly> [--hard <usd|none>] [--soft <usd|none>]
  admin-token:create <name> --role <platform_admin|tenant_admin|finance_viewer> [--tenant <slug>]
  admin-jwt:mint --role <role> [--tenant <slug>] [--subject <email>] [--ttl <seconds>]
  demo:seed [--days <n>]`;

function adminRole(raw: string | undefined): AdminRole {
  if (raw === 'platform_admin' || raw === 'tenant_admin' || raw === 'finance_viewer') return raw;
  return fail('--role must be platform_admin, tenant_admin or finance_viewer');
}

function usdValue(raw: string | undefined, name: string): bigint | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'none') return null;
  if (!/^\d+(\.\d{1,6})?$/.test(raw))
    fail(`--${name} must be a USD amount like 25 or 0.50, or "none"`);
  const [whole, fraction = ''] = raw.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

/** Reads `--flag value` pairs into a map. */
function flags(args: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith('--')) out.set(args[i]!.slice(2), args[i + 1] ?? '');
  }
  return out;
}

function limitValue(raw: string | undefined, name: string): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'none') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) fail(`--${name} must be a positive integer or "none"`);
  return n;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

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

/** `--platform` selects the platform-default scope (null tenant). */
async function ownerId(arg: string | undefined): Promise<string | null> {
  return arg === '--platform' ? null : tenantId(arg);
}

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
    case 'credential:set': {
      const [owner, provider, label, flag, baseUrl] = args;
      if (!provider || !label) fail(usage);
      if (process.stdin.isTTY) console.error('Paste the provider secret, then press Ctrl-D:');
      // Read from stdin so the secret never lands in shell history or the process list.
      const secret = await readStdin();
      const result = await setCredential(
        db,
        keyProviderFromConfig(config),
        {
          tenantId: await ownerId(owner),
          provider,
          label,
          secret,
          baseUrl: flag === '--base-url' ? (baseUrl ?? null) : null,
        },
        actor,
      );
      console.log(`Stored ${provider} credential "${label}" ending in ${result.last4}`);
      break;
    }
    case 'credential:list': {
      const rows = await listCredentials(db, await ownerId(args[0]));
      console.table(
        rows.map((c) => ({
          provider: c.provider,
          label: c.label,
          scope: c.scope,
          secret: `…${c.last4}`,
          baseUrl: c.baseUrl ?? '-',
        })),
      );
      break;
    }
    case 'credentials:reencrypt': {
      const count = await reencryptCredentials(db, keyProviderFromConfig(config));
      console.log(
        `Re-wrapped ${count} credential(s) under master key v${config.GATEWAY_MASTER_KEY_VERSION}`,
      );
      break;
    }
    case 'limits:set': {
      const [slug, ...rest] = args;
      const f = flags(rest);
      const rpm = limitValue(f.get('rpm'), 'rpm');
      const tpm = limitValue(f.get('tpm'), 'tpm');
      if (rpm === undefined && tpm === undefined) fail(usage);
      const redis = createRedis(config.REDIS_URL);
      await redis.connect();
      try {
        await setRateLimits(
          db,
          redis,
          { tenantId: await tenantId(slug), ...(f.get('key') ? { keyPrefix: f.get('key')! } : {}) },
          { ...(rpm !== undefined ? { rpm } : {}), ...(tpm !== undefined ? { tpm } : {}) },
          actor,
        );
      } finally {
        redis.disconnect();
      }
      console.log(
        `Rate limits updated for ${f.get('key') ? `key ${f.get('key')}` : `tenant ${slug}`}`,
      );
      break;
    }
    case 'budget:set': {
      const [slug, period, ...rest] = args;
      if (period !== 'daily' && period !== 'monthly') fail(usage);
      const f = flags(rest);
      const hard = usdValue(f.get('hard'), 'hard');
      const soft = usdValue(f.get('soft'), 'soft');
      if (hard === undefined && soft === undefined) fail(usage);
      await setBudget(
        db,
        {
          tenantId: await tenantId(slug),
          period,
          ...(hard !== undefined ? { hardLimitMicros: hard } : {}),
          ...(soft !== undefined ? { softLimitMicros: soft } : {}),
        },
        actor,
      );
      console.log(`${period} budget updated for ${slug}`);
      break;
    }
    case 'admin-token:create': {
      const [name, ...rest] = args;
      if (!name) fail(usage);
      const f = flags(rest);
      const role = adminRole(f.get('role'));
      const scope = role === 'platform_admin' ? null : await tenantId(f.get('tenant'));
      const { token, prefix } = await createAdminToken(db, { name, role, tenantId: scope }, actor);
      console.log(
        `Created ${role} service token "${name}" (prefix ${prefix}). Copy it now; it cannot be shown again:\n`,
      );
      console.log(token);
      break;
    }
    case 'admin-jwt:mint': {
      // Development convenience: production dashboards mint these server-side after sign-in.
      if (!config.ADMIN_JWT_SECRET) fail('ADMIN_JWT_SECRET is not set');
      const f = flags(args);
      const role = adminRole(f.get('role'));
      const scope = role === 'platform_admin' ? null : await tenantId(f.get('tenant'));
      const ttl = f.get('ttl') ? Number(f.get('ttl')) : 15 * 60;
      console.log(
        await mintAdminJwt(
          config.ADMIN_JWT_SECRET,
          { subject: f.get('subject') ?? `cli:${userInfo().username}`, role, tenantId: scope },
          ttl,
        ),
      );
      break;
    }
    case 'demo:seed': {
      const days = Number(flags(args).get('days') ?? 30);
      if (!Number.isInteger(days) || days < 1 || days > 90) fail('--days must be 1 to 90');
      const report = await seedDemo(db, actor, days);
      console.log(
        `Seeded ${report.events} usage events over ${days} days for: ${report.tenants.map((t) => t.slug).join(', ')}`,
      );
      console.log(
        `DEMO_TENANT_ID=${report.tenants[0]!.id}   # read-only demo login shows this tenant`,
      );
      if (report.apiKey)
        console.log(`Demo API key for ${report.tenants[0]!.slug}: ${report.apiKey}`);
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
