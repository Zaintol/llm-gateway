import { Authenticator, type AuthenticatorOptions } from '../../src/auth/authenticator.js';
import type { FailureLimiter } from '../../src/auth/failure-limiter.js';
import type { KeyRecord, KeyStore } from '../../src/auth/key-store.js';
import { generateApiKey } from '../../src/auth/keys.js';
import type { DataPlaneAuth } from '../../src/auth/plugin.js';

export class InMemoryKeyStore implements KeyStore {
  readonly records = new Map<string, KeyRecord>();
  lookups = 0;
  touches: string[] = [];

  async findByPrefix(prefix: string): Promise<KeyRecord | null> {
    this.lookups++;
    return this.records.get(prefix) ?? null;
  }

  async touchLastUsed(keyId: string): Promise<void> {
    this.touches.push(keyId);
  }

  /** Adds a key and returns the full key string a client would send. */
  add(overrides: Partial<KeyRecord> = {}): { key: string; record: KeyRecord } {
    const generated = generateApiKey();
    const record: KeyRecord = {
      keyId: `key_${generated.prefix}`,
      tenantId: 'tenant_1',
      prefix: generated.prefix,
      secretHash: generated.secretHash,
      expiresAt: null,
      revokedAt: null,
      tenantStatus: 'active',
      tenantSettings: {},
      ...overrides,
    };
    this.records.set(record.prefix, record);
    return { key: generated.key, record };
  }
}

export class InMemoryFailureLimiter implements FailureLimiter {
  readonly failures = new Map<string, number>();
  constructor(private readonly limit = 20) {}

  async isBlocked(ip: string): Promise<boolean> {
    return (this.failures.get(ip) ?? 0) >= this.limit;
  }

  async recordFailure(ip: string): Promise<void> {
    this.failures.set(ip, (this.failures.get(ip) ?? 0) + 1);
  }
}

export function fakeAuth(options: AuthenticatorOptions = {}) {
  const store = new InMemoryKeyStore();
  const failureLimiter = new InMemoryFailureLimiter();
  const auth: DataPlaneAuth = { authenticator: new Authenticator(store, options), failureLimiter };
  return { store, failureLimiter, auth };
}
