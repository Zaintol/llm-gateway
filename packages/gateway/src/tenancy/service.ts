import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { publishKeyInvalidation } from '../auth/invalidation.js';
import { generateApiKey } from '../auth/keys.js';
import type { Db } from '../db/client.js';
import { apiKeys, auditLog, tenants } from '../db/schema.js';
import { GatewayError } from '../errors.js';

export type Actor = { type: 'admin' | 'system'; id: string };

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
      metadata: { slug: input.slug },
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
      metadata: { prefix: generated.prefix, name: input.name },
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
      metadata: { prefix: input.prefix },
    });
    return true;
  });
  if (!revoked) {
    throw new GatewayError(404, 'not_found', 'api_key_not_found', 'No active key with that prefix');
  }
  await publishKeyInvalidation(redis, input.prefix);
}
