import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeyProvider } from './key-provider.js';

export type SealedSecret = {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  wrappedDek: Buffer;
  masterKeyVersion: number;
};

/**
 * Envelope encryption: a fresh 256-bit data key encrypts the secret with AES-256-GCM, then the
 * data key is wrapped by the master key. `aad` binds the ciphertext to its owner, so a row copied
 * to another tenant or provider fails to decrypt.
 */
export async function seal(
  plaintext: string,
  aad: string,
  keys: KeyProvider,
): Promise<SealedSecret> {
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const { wrapped, version } = await keys.wrap(dek);
  dek.fill(0);
  return {
    ciphertext,
    iv,
    authTag: cipher.getAuthTag(),
    wrappedDek: wrapped,
    masterKeyVersion: version,
  };
}

export async function open(sealed: SealedSecret, aad: string, keys: KeyProvider): Promise<string> {
  const dek = await keys.unwrap(sealed.wrappedDek, sealed.masterKeyVersion);
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, sealed.iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(sealed.authTag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
  } finally {
    dek.fill(0);
  }
}

/** Re-wraps the data key under the current master key. The secret ciphertext is untouched. */
export async function rewrap(
  sealed: SealedSecret,
  keys: KeyProvider,
): Promise<Pick<SealedSecret, 'wrappedDek' | 'masterKeyVersion'>> {
  const dek = await keys.unwrap(sealed.wrappedDek, sealed.masterKeyVersion);
  try {
    const { wrapped, version } = await keys.wrap(dek);
    return { wrappedDek: wrapped, masterKeyVersion: version };
  } finally {
    dek.fill(0);
  }
}
