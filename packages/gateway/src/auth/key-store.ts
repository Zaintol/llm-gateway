import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { apiKeys, tenantSettings, tenants } from '../db/schema.js';

export type KeyRecord = {
  keyId: string;
  tenantId: string;
  prefix: string;
  secretHash: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  tenantStatus: 'active' | 'suspended';
  tenantSettings: Record<string, unknown>;
  limits: RateLimits;
};

export type Limit = { rpm: number | null; tpm: number | null };
/** Per-key and tenant-wide rate limits; null means unlimited. */
export type RateLimits = { key: Limit; tenant: Limit };

export interface KeyStore {
  findByPrefix(prefix: string): Promise<KeyRecord | null>;
  touchLastUsed(keyId: string, at: Date): Promise<void>;
}

export class PgKeyStore implements KeyStore {
  constructor(private readonly db: Db) {}

  async findByPrefix(prefix: string): Promise<KeyRecord | null> {
    const [row] = await this.db
      .select({
        keyId: apiKeys.id,
        tenantId: apiKeys.tenantId,
        prefix: apiKeys.prefix,
        secretHash: apiKeys.secretHash,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
        tenantStatus: tenants.status,
        tenantSettings: tenantSettings.settings,
        keyRpm: apiKeys.rpmLimit,
        keyTpm: apiKeys.tpmLimit,
        tenantRpm: tenants.rpmLimit,
        tenantTpm: tenants.tpmLimit,
      })
      .from(apiKeys)
      .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
      .leftJoin(tenantSettings, eq(tenantSettings.tenantId, apiKeys.tenantId))
      .where(eq(apiKeys.prefix, prefix))
      .limit(1);
    if (!row) return null;
    const { keyRpm, keyTpm, tenantRpm, tenantTpm, ...rest } = row;
    return {
      ...rest,
      tenantSettings: (row.tenantSettings as Record<string, unknown> | null) ?? {},
      limits: { key: { rpm: keyRpm, tpm: keyTpm }, tenant: { rpm: tenantRpm, tpm: tenantTpm } },
    };
  }

  async touchLastUsed(keyId: string, at: Date): Promise<void> {
    await this.db.update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, keyId));
  }
}
