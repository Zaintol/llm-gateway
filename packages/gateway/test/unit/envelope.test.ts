import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { open, rewrap, seal } from '../../src/credentials/envelope.js';
import { LocalKeyProvider } from '../../src/credentials/key-provider.js';

const v1 = randomBytes(32);
const v2 = randomBytes(32);
const secret = 'sk-ant-api03-EXAMPLE-not-a-real-key-1234';

describe('envelope encryption', () => {
  it('round-trips a secret', async () => {
    const keys = new LocalKeyProvider(1, new Map([[1, v1]]));
    const sealed = await seal(secret, 'aad', keys);
    expect(await open(sealed, 'aad', keys)).toBe(secret);
  });

  it('stores no substring of the secret in the ciphertext', async () => {
    const keys = new LocalKeyProvider(1, new Map([[1, v1]]));
    const sealed = await seal(secret, 'aad', keys);
    for (let i = 0; i + 4 <= secret.length; i++) {
      expect(sealed.ciphertext.includes(Buffer.from(secret.slice(i, i + 4)))).toBe(false);
    }
  });

  it('uses a fresh data key and iv per secret', async () => {
    const keys = new LocalKeyProvider(1, new Map([[1, v1]]));
    const [a, b] = await Promise.all([seal(secret, 'aad', keys), seal(secret, 'aad', keys)]);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
  });

  it('refuses to decrypt under different associated data', async () => {
    const keys = new LocalKeyProvider(1, new Map([[1, v1]]));
    const sealed = await seal(secret, 'provider_credential:tenant-a:openai', keys);
    await expect(open(sealed, 'provider_credential:tenant-b:openai', keys)).rejects.toThrow();
  });

  it('refuses tampered ciphertext', async () => {
    const keys = new LocalKeyProvider(1, new Map([[1, v1]]));
    const sealed = await seal(secret, 'aad', keys);
    sealed.ciphertext[0]! ^= 1;
    await expect(open(sealed, 'aad', keys)).rejects.toThrow();
  });

  it('re-wraps a data key under a rotated master key without changing the ciphertext', async () => {
    const before = new LocalKeyProvider(1, new Map([[1, v1]]));
    const sealed = await seal(secret, 'aad', before);
    const rotating = new LocalKeyProvider(
      2,
      new Map([
        [1, v1],
        [2, v2],
      ]),
    );
    const rewrapped = { ...sealed, ...(await rewrap(sealed, rotating)) };
    expect(rewrapped.masterKeyVersion).toBe(2);

    const after = new LocalKeyProvider(2, new Map([[2, v2]]));
    expect(await open(rewrapped, 'aad', after)).toBe(secret);
    await expect(open(sealed, 'aad', after)).rejects.toThrow(/v1 is not configured/);
  });

  it('rejects master keys that are not 32 bytes', () => {
    expect(() => new LocalKeyProvider(1, new Map([[1, randomBytes(16)]]))).toThrow(/32 bytes/);
  });
});
