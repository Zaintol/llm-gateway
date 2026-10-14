import { and, eq, isNull, ne, or } from 'drizzle-orm';
import type { Config } from '../config.js';
import { TtlCache } from '../auth/ttl-cache.js';
import type { Db } from '../db/client.js';
import { auditLog, providerCredentials } from '../db/schema.js';
import { auditContext, type Actor } from '../tenancy/service.js';
import { open, rewrap, seal } from './envelope.js';
import { LocalKeyProvider, type KeyProvider } from './key-provider.js';

export type CredentialScope = 'tenant' | 'platform';

export function keyProviderFromConfig(config: Config): KeyProvider {
  const keys = new Map<number, Buffer>();
  for (const [version, key] of config.GATEWAY_PREVIOUS_MASTER_KEYS) {
    keys.set(version, Buffer.from(key, 'base64'));
  }
  keys.set(config.GATEWAY_MASTER_KEY_VERSION, Buffer.from(config.GATEWAY_MASTER_KEY, 'base64'));
  return new LocalKeyProvider(config.GATEWAY_MASTER_KEY_VERSION, keys);
}

/** Additional authenticated data: ties a sealed secret to its owner and provider. */
const aadFor = (tenantId: string | null, provider: string) =>
  `provider_credential:${tenantId ?? 'platform'}:${provider}`;

const ownerIs = (tenantId: string | null) =>
  tenantId === null
    ? isNull(providerCredentials.tenantId)
    : eq(providerCredentials.tenantId, tenantId);

/** Creates or replaces the credential for (tenant, provider). `tenantId: null` sets the platform default. */
export async function setCredential(
  db: Db,
  keys: KeyProvider,
  input: {
    tenantId: string | null;
    provider: string;
    label: string;
    secret: string;
    baseUrl?: string | null;
  },
  actor: Actor,
): Promise<{ id: string; last4: string }> {
  if (input.secret.length < 8) throw new Error('secret is too short to be a provider API key');
  const sealed = await seal(input.secret, aadFor(input.tenantId, input.provider), keys);
  const values = {
    tenantId: input.tenantId,
    provider: input.provider,
    label: input.label,
    last4: input.secret.slice(-4),
    baseUrl: input.baseUrl ?? null,
    ...sealed,
  };
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(providerCredentials)
      .values(values)
      .onConflictDoUpdate({
        target: [providerCredentials.tenantId, providerCredentials.provider],
        set: { ...values, rotatedAt: new Date() },
      })
      .returning({ id: providerCredentials.id });
    await tx.insert(auditLog).values({
      actorType: actor.type,
      actorId: actor.id,
      tenantId: input.tenantId,
      action: 'provider_credential.set',
      targetType: 'provider_credential',
      targetId: row!.id,
      metadata: {
        ...auditContext(actor),
        provider: input.provider,
        label: input.label,
        last4: values.last4,
      },
    });
    return { id: row!.id, last4: values.last4 };
  });
}

/** Safe projection for APIs and CLIs: never includes ciphertext or the secret. */
export async function listCredentials(db: Db, tenantId: string | null) {
  const rows = await db
    .select({
      id: providerCredentials.id,
      tenantId: providerCredentials.tenantId,
      provider: providerCredentials.provider,
      label: providerCredentials.label,
      last4: providerCredentials.last4,
      baseUrl: providerCredentials.baseUrl,
      createdAt: providerCredentials.createdAt,
      rotatedAt: providerCredentials.rotatedAt,
    })
    .from(providerCredentials)
    .where(
      tenantId === null
        ? isNull(providerCredentials.tenantId)
        : or(ownerIs(tenantId), isNull(providerCredentials.tenantId)),
    );
  return rows.map(({ tenantId: owner, ...row }) => ({
    ...row,
    scope: (owner === null ? 'platform' : 'tenant') as CredentialScope,
  }));
}

export type ResolvedCredential = {
  secret: string;
  baseUrl: string | null;
  scope: CredentialScope;
};

/**
 * Finds the credential to use for a tenant's call to a provider: tenant-scoped wins over the
 * platform default. Decrypted secrets are cached in memory for 5 minutes.
 */
export class CredentialResolver {
  private readonly cache: TtlCache<ResolvedCredential | null>;

  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
    options: { cacheTtlMs?: number; now?: () => number } = {},
  ) {
    this.cache = new TtlCache(10_000, options.cacheTtlMs ?? 5 * 60_000, options.now);
  }

  async resolve(tenantId: string, provider: string): Promise<ResolvedCredential | null> {
    const cacheKey = `${tenantId}:${provider}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const rows = await this.db
      .select()
      .from(providerCredentials)
      .where(
        and(
          eq(providerCredentials.provider, provider),
          or(eq(providerCredentials.tenantId, tenantId), isNull(providerCredentials.tenantId)),
        ),
      );
    const row = rows.find((r) => r.tenantId === tenantId) ?? rows.find((r) => r.tenantId === null);
    const resolved = row
      ? {
          secret: await open(row, aadFor(row.tenantId, row.provider), this.keys),
          baseUrl: row.baseUrl,
          scope: (row.tenantId === null ? 'platform' : 'tenant') as CredentialScope,
        }
      : null;
    this.cache.set(cacheKey, resolved);
    return resolved;
  }

  invalidate(tenantId: string, provider: string): void {
    this.cache.delete(`${tenantId}:${provider}`);
  }

  /** Platform-default credentials back every tenant, so a change to one clears everything. */
  invalidateAll(): void {
    this.cache.clear();
  }
}

/**
 * Re-wraps every data key that is not under the current master key version. Run after
 * rotating GATEWAY_MASTER_KEY while the old key is still listed in GATEWAY_PREVIOUS_MASTER_KEYS.
 */
export async function reencryptCredentials(db: Db, keys: KeyProvider): Promise<number> {
  const stale = await db
    .select()
    .from(providerCredentials)
    .where(ne(providerCredentials.masterKeyVersion, keys.currentVersion));
  for (const row of stale) {
    const rewrapped = await rewrap(row, keys);
    await db
      .update(providerCredentials)
      .set(rewrapped)
      .where(
        and(
          eq(providerCredentials.id, row.id),
          eq(providerCredentials.masterKeyVersion, row.masterKeyVersion),
        ),
      );
  }
  return stale.length;
}
