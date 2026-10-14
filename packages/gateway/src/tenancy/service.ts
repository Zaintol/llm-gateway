import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { publishKeyInvalidation } from '../auth/invalidation.js';
import { generateApiKey } from '../auth/keys.js';
import type { Db } from '../db/client.js';
import { apiKeys, auditLog, budgets, tenants } from '../db/schema.js';
import { GatewayError } from '../errors.js';

export type AdminRole = 'platform_admin' | 'tenant_admin' | 'finance_viewer';

/** Who made a change. `role` and `route` are recorded when it came through the admin API. */
export type Actor = { type: 'admin' | 'system'; id: string; role?: AdminRole; route?: string };

/** Actor details every audit row carries in its metadata. */
export const auditContext = (actor: Actor) => ({
  ...(actor.role ? { role: actor.role } : {}),
  ...(actor.route ? { route: actor.route } : {}),
});

export async function createTenant(db: Db, input: { slug: string; name: string }, actor: Actor) {
  return db.transaction(async (tx) => {
    const [tenant] = await tx.insert(tenants).values(input).returning();
    await tx.insert(auditLog).values({
      actorType: actor.type,
      actorId: actor.id,
      tenantId: tenant!.id,
      action: 'tenant.create',
      targetType: 'tenant',
      targetId: tenant!.id,
      metadata: {
        ...auditContext(actor),
        slug: input.slug,
      },
    });
    return tenant!;
  });
}

export async function findTenantBySlug(db: Db, slug: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  return tenant ?? null;
}

export type CreatedApiKey = {
  id: string;
  name: string;
  prefix: string;
  /** The full key. Returned once at creation; only its hash is stored. */
  key: string;
  createdAt: Date;
  expiresAt: Date | null;
};

export async function createApiKey(
  db: Db,
  input: { tenantId: string; name: string; expiresAt?: Date | null },
  actor: Actor,
): Promise<CreatedApiKey> {
  const generated = generateApiKey();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(apiKeys)
      .values({
        tenantId: input.tenantId,
        name: input.name,
        prefix: generated.prefix,
        secretHash: generated.secretHash,
        createdBy: actor.id,
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    await tx.insert(auditLog).values({
      actorType: actor.type,
      actorId: actor.id,
      tenantId: input.tenantId,
      action: 'api_key.create',
      targetType: 'api_key',
      targetId: row!.id,
      metadata: {
        ...auditContext(actor),
        prefix: generated.prefix,
        name: input.name,
      },
    });
    return {
      id: row!.id,
      name: row!.name,
      prefix: row!.prefix,
      key: generated.key,
      createdAt: row!.createdAt,
      expiresAt: row!.expiresAt,
    };
  });
}

/** Never selects the secret hash. */
export async function listApiKeys(db: Db, tenantId: string) {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      createdBy: apiKeys.createdBy,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.tenantId, tenantId))
    .orderBy(desc(apiKeys.createdAt));
}

/**
 * Revokes a key and broadcasts the revocation so every gateway instance drops its cached entry
 * immediately rather than waiting for the cache TTL.
 */
export async function revokeApiKey(
  db: Db,
  redis: Redis,
  input: { tenantId: string; prefix: string },
  actor: Actor,
): Promise<void> {
  const revoked = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiKeys.tenantId, input.tenantId),
          eq(apiKeys.prefix, input.prefix),
          isNull(apiKeys.revokedAt),
        ),
      )
      .returning({ id: apiKeys.id });
    if (!row) return false;
    await tx.insert(auditLog).values({
      actorType: actor.type,
      actorId: actor.id,
      tenantId: input.tenantId,
      action: 'api_key.revoke',
      targetType: 'api_key',
      targetId: row.id,
      metadata: {
        ...auditContext(actor),
        prefix: input.prefix,
      },
    });
    return true;
  });
  if (!revoked) {
    throw new GatewayError(404, 'not_found', 'api_key_not_found', 'No active key with that prefix');
  }
  await publishKeyInvalidation(redis, input.prefix);
}

export type LimitUpdate = { rpm?: number | null; tpm?: number | null };

/** Sets tenant-wide or per-key rate limits (null removes a limit). Takes effect within the auth cache TTL. */
export async function setRateLimits(
  db: Db,
  redis: Redis,
  target: { tenantId: string; keyPrefix?: string },
  limits: LimitUpdate,
  actor: Actor,
): Promise<void> {
  const values = {
    ...(limits.rpm !== undefined ? { rpmLimit: limits.rpm } : {}),
    ...(limits.tpm !== undefined ? { tpmLimit: limits.tpm } : {}),
  };
  if (Object.keys(values).length === 0) return;
  await db.transaction(async (tx) => {
    let targetId: string;
    if (target.keyPrefix) {
      const [row] = await tx
        .update(apiKeys)
        .set(values)
        .where(and(eq(apiKeys.tenantId, target.tenantId), eq(apiKeys.prefix, target.keyPrefix)))
        .returning({ id: apiKeys.id });
      if (!row)
        throw new GatewayError(404, 'not_found', 'api_key_not_found', 'No key with that prefix');
      targetId = row.id;
    } else {
      await tx.update(tenants).set(values).where(eq(tenants.id, target.tenantId));
      targetId = target.tenantId;
    }
    await tx.insert(auditLog).values({
      actorType: actor.type,
      actorId: actor.id,
      tenantId: target.tenantId,
      action: 'rate_limits.set',
      targetType: target.keyPrefix ? 'api_key' : 'tenant',
      targetId,
      metadata: {
        ...auditContext(actor),
        ...limits,
        ...(target.keyPrefix ? { prefix: target.keyPrefix } : {}),
      },
    });
  });
  // Cached auth entries carry the limits; drop them so the change applies on the next request.
  if (target.keyPrefix) await publishKeyInvalidation(redis, target.keyPrefix);
  else {
    const keys = await db
      .select({ prefix: apiKeys.prefix })
      .from(apiKeys)
      .where(eq(apiKeys.tenantId, target.tenantId));
    await Promise.all(keys.map((k) => publishKeyInvalidation(redis, k.prefix)));
  }
}

/** Sets a tenant-wide daily or monthly budget (null removes a limit). Applies within ~30 s. */
export async function setBudget(
  db: Db,
  input: {
    tenantId: string;
    period: 'daily' | 'monthly';
    hardLimitMicros?: bigint | null;
    softLimitMicros?: bigint | null;
  },
  actor: Actor,
): Promise<void> {
  const values = {
    ...(input.hardLimitMicros !== undefined ? { hardLimitMicros: input.hardLimitMicros } : {}),
    ...(input.softLimitMicros !== undefined ? { softLimitMicros: input.softLimitMicros } : {}),
  };
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(budgets)
      .values({ tenantId: input.tenantId, apiKeyId: null, period: input.period, ...values })
      .onConflictDoUpdate({
        target: [budgets.tenantId, budgets.apiKeyId, budgets.period],
        set: values,
      })
      .returning({ id: budgets.id });
    await tx.insert(auditLog).values({
      actorType: actor.type,
      actorId: actor.id,
      tenantId: input.tenantId,
      action: 'budget.set',
      targetType: 'budget',
      targetId: row!.id,
      metadata: {
        ...auditContext(actor),
        period: input.period,
        hardLimitMicros: input.hardLimitMicros?.toString() ?? null,
        softLimitMicros: input.softLimitMicros?.toString() ?? null,
      },
    });
  });
}
