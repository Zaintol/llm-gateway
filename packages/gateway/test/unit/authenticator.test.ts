import { describe, expect, it } from 'vitest';
import { Authenticator } from '../../src/auth/authenticator.js';
import type { GatewayError } from '../../src/errors.js';
import { InMemoryKeyStore } from '../support/fakes.js';

async function failure(promise: Promise<unknown>): Promise<GatewayError> {
  try {
    await promise;
  } catch (err) {
    return err as GatewayError;
  }
  throw new Error('expected authentication to fail');
}

describe('Authenticator', () => {
  it('returns the tenant context for a valid key', async () => {
    const store = new InMemoryKeyStore();
    const { key, record } = store.add({ tenantSettings: { region: 'eu' } });
    const ctx = await new Authenticator(store).authenticate(`Bearer ${key}`);
    expect(ctx).toEqual({
      tenantId: record.tenantId,
      keyId: record.keyId,
      keyPrefix: record.prefix,
      tenantSettings: { region: 'eu' },
    });
  });

  it.each([
    ['missing header', undefined, 'missing_api_key'],
    ['non-bearer scheme', 'Basic abc', 'missing_api_key'],
    ['malformed key', 'Bearer sk-123', 'invalid_api_key'],
    ['unknown prefix', `Bearer gw_live_ZZZZZZZZ_${'a'.repeat(43)}`, 'invalid_api_key'],
  ])('rejects a %s with 401', async (_case, header, code) => {
    const err = await failure(new Authenticator(new InMemoryKeyStore()).authenticate(header));
    expect(err).toMatchObject({ status: 401, type: 'authentication', code });
  });

  it('rejects a known prefix with the wrong secret as invalid, not revoked or expired', async () => {
    const store = new InMemoryKeyStore();
    const { key } = store.add({ revokedAt: new Date(0) });
    const forged = `${key.slice(0, -1)}${key.endsWith('a') ? 'b' : 'a'}`;
    const err = await failure(new Authenticator(store).authenticate(`Bearer ${forged}`));
    expect(err.code).toBe('invalid_api_key');
  });

  it('rejects a revoked key', async () => {
    const store = new InMemoryKeyStore();
    const { key } = store.add({ revokedAt: new Date() });
    const err = await failure(new Authenticator(store).authenticate(`Bearer ${key}`));
    expect(err).toMatchObject({ status: 401, code: 'key_revoked' });
  });

  it('rejects a key past its expiry with key_expired', async () => {
    const store = new InMemoryKeyStore();
    const { key } = store.add({ expiresAt: new Date(1_000) });
    const auth = new Authenticator(store, { now: () => 1_000 });
    const err = await failure(auth.authenticate(`Bearer ${key}`));
    expect(err).toMatchObject({ status: 401, type: 'authentication', code: 'key_expired' });
  });

  it('rejects keys of a suspended tenant with 403', async () => {
    const store = new InMemoryKeyStore();
    const { key } = store.add({ tenantStatus: 'suspended' });
    const err = await failure(new Authenticator(store).authenticate(`Bearer ${key}`));
    expect(err).toMatchObject({ status: 403, type: 'permission', code: 'tenant_suspended' });
  });

  it('serves repeat lookups from cache until invalidated', async () => {
    const store = new InMemoryKeyStore();
    const { key, record } = store.add();
    const auth = new Authenticator(store);
    await auth.authenticate(`Bearer ${key}`);
    await auth.authenticate(`Bearer ${key}`);
    expect(store.lookups).toBe(1);

    store.records.set(record.prefix, { ...record, revokedAt: new Date() });
    auth.invalidate(record.prefix);
    const err = await failure(auth.authenticate(`Bearer ${key}`));
    expect(err.code).toBe('key_revoked');
    expect(store.lookups).toBe(2);
  });

  it('reloads a cached key after the cache ttl', async () => {
    let now = 0;
    const store = new InMemoryKeyStore();
    const { key } = store.add();
    const auth = new Authenticator(store, { cacheTtlMs: 30_000, now: () => now });
    await auth.authenticate(`Bearer ${key}`);
    now = 30_000;
    await auth.authenticate(`Bearer ${key}`);
    expect(store.lookups).toBe(2);
  });

  it('writes last_used_at at most once per interval', async () => {
    let now = 0;
    const store = new InMemoryKeyStore();
    const { key, record } = store.add();
    const auth = new Authenticator(store, { touchIntervalMs: 60_000, now: () => now });
    for (let i = 0; i < 5; i++) await auth.authenticate(`Bearer ${key}`);
    now = 60_000;
    await auth.authenticate(`Bearer ${key}`);
    expect(store.touches).toEqual([record.keyId, record.keyId]);
  });
});
