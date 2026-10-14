import { GatewayError } from '../errors.js';
import type { KeyRecord, KeyStore } from './key-store.js';
import { parseApiKey, secretMatches } from './keys.js';
import { TtlCache } from './ttl-cache.js';

export type AuthContext = {
  tenantId: string;
  keyId: string;
  keyPrefix: string;
  tenantSettings: Record<string, unknown>;
};

export type AuthenticatorOptions = {
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  /** last_used_at is written at most this often per key. */
  touchIntervalMs?: number;
  now?: () => number;
  onTouchError?: (err: unknown) => void;
};

const invalidKey = () =>
  new GatewayError(401, 'authentication', 'invalid_api_key', 'Invalid API key provided');

export class Authenticator {
  private readonly cache: TtlCache<KeyRecord>;
  private readonly lastTouched: TtlCache<true>;
  private readonly now: () => number;

  constructor(
    private readonly store: KeyStore,
    private readonly options: AuthenticatorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    const maxEntries = options.maxCacheEntries ?? 10_000;
    this.cache = new TtlCache(maxEntries, options.cacheTtlMs ?? 30_000, this.now);
    this.lastTouched = new TtlCache(maxEntries, options.touchIntervalMs ?? 60_000, this.now);
  }

  async authenticate(authorization: string | undefined): Promise<AuthContext> {
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
    if (!token) {
      throw new GatewayError(
        401,
        'authentication',
        'missing_api_key',
        'Missing API key. Send it as "Authorization: Bearer <key>"',
      );
    }
    const parsed = parseApiKey(token);
    if (!parsed) throw invalidKey();

    const record = await this.lookup(parsed.prefix);
    // Verify the secret before revealing anything about the key's state.
    if (!record || !secretMatches(parsed.secret, record.secretHash)) throw invalidKey();
    if (record.revokedAt) {
      throw new GatewayError(401, 'authentication', 'key_revoked', 'This API key has been revoked');
    }
    if (record.expiresAt && record.expiresAt.getTime() <= this.now()) {
      throw new GatewayError(401, 'authentication', 'key_expired', 'This API key has expired');
    }
    if (record.tenantStatus !== 'active') {
      throw new GatewayError(403, 'permission', 'tenant_suspended', 'This tenant is suspended');
    }

    this.touch(record.keyId);
    return {
      tenantId: record.tenantId,
      keyId: record.keyId,
      keyPrefix: record.prefix,
      tenantSettings: record.tenantSettings,
    };
  }

  /** Drops a cached key, e.g. after a revocation broadcast. */
  invalidate(prefix: string): void {
    this.cache.delete(prefix);
  }

  private async lookup(prefix: string): Promise<KeyRecord | null> {
    const cached = this.cache.get(prefix);
    if (cached) return cached;
    const record = await this.store.findByPrefix(prefix);
    if (record) this.cache.set(prefix, record);
    return record;
  }

  private touch(keyId: string): void {
    if (this.lastTouched.get(keyId)) return;
    this.lastTouched.set(keyId, true);
    this.store.touchLastUsed(keyId, new Date(this.now())).catch((err: unknown) => {
      this.options.onTouchError?.(err);
    });
  }
}
