import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Wraps and unwraps per-credential data keys (DEKs) with a versioned master key.
 * The local implementation holds master keys in memory; a cloud KMS can implement the same
 * interface without touching the credential code.
 */
export interface KeyProvider {
  readonly currentVersion: number;
  wrap(dek: Buffer): Promise<{ wrapped: Buffer; version: number }>;
  unwrap(wrapped: Buffer, version: number): Promise<Buffer>;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Wrapped layout: iv (12) | auth tag (16) | ciphertext (32). */
export class LocalKeyProvider implements KeyProvider {
  private readonly keys: Map<number, Buffer>;

  constructor(
    readonly currentVersion: number,
    keys: Map<number, Buffer>,
  ) {
    for (const [version, key] of keys) {
      if (key.length !== 32) throw new Error(`master key v${version} must be 32 bytes`);
    }
    if (!keys.has(currentVersion)) throw new Error(`master key v${currentVersion} is missing`);
    this.keys = keys;
  }

  async wrap(dek: Buffer) {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.currentVersion)!, iv);
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    return {
      wrapped: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]),
      version: this.currentVersion,
    };
  }

  async unwrap(wrapped: Buffer, version: number) {
    const key = this.keys.get(version);
    if (!key) throw new Error(`master key v${version} is not configured`);
    const decipher = createDecipheriv('aes-256-gcm', key, wrapped.subarray(0, IV_BYTES));
    decipher.setAuthTag(wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(wrapped.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]);
  }
}
