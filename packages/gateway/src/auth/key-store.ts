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
};

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
      })
      .from(apiKeys)
      .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
      .leftJoin(tenantSettings, eq(tenantSettings.tenantId, apiKeys.tenantId))
      .where(eq(apiKeys.prefix, prefix))
      .limit(1);
    if (!row) return null;
    return { ...row, tenantSettings: (row.tenantSettings as Record<string, unknown> | null) ?? {} };
  }

  async touchLastUsed(keyId: string, at: Date): Promise<void> {
    await this.db.update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, keyId));
  }
}
