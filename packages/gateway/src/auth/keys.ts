import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const KEY_PREFIX_LENGTH = 8;
/** 43 base62 characters carry 256 bits of entropy. */
export const KEY_SECRET_LENGTH = 43;
const KEY_PATTERN = /^gw_live_([0-9A-Za-z]{8})_([0-9A-Za-z]{43})$/;

/** Uniform base62 via rejection sampling (bytes >= 248 would bias `% 62`). */
export function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= 248) continue;
      out += ALPHABET[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * Secrets are 256-bit random values, so a single SHA-256 is sufficient: there is nothing for a
 * slow password hash to protect against, and auth stays on the hot path's latency budget.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function secretMatches(secret: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export type GeneratedApiKey = { key: string; prefix: string; secretHash: string };

export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBase62(KEY_PREFIX_LENGTH);
  const secret = randomBase62(KEY_SECRET_LENGTH);
  return { key: `gw_live_${prefix}_${secret}`, prefix, secretHash: hashSecret(secret) };
}

export function parseApiKey(token: string): { prefix: string; secret: string } | null {
  const match = KEY_PATTERN.exec(token);
  return match ? { prefix: match[1]!, secret: match[2]! } : null;
}

export function looksLikeDataPlaneKey(token: string): boolean {
  return token.startsWith('gw_live_');
}
