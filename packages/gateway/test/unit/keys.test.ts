import { describe, expect, it } from 'vitest';
import {
  generateApiKey,
  hashSecret,
  parseApiKey,
  randomBase62,
  secretMatches,
} from '../../src/auth/keys.js';

describe('api keys', () => {
  it('have the gw_live_<prefix>_<secret> format and round-trip through parsing', () => {
    const { key, prefix, secretHash } = generateApiKey();
    expect(key).toMatch(/^gw_live_[0-9A-Za-z]{8}_[0-9A-Za-z]{43}$/);
    const parsed = parseApiKey(key);
    expect(parsed?.prefix).toBe(prefix);
    expect(hashSecret(parsed!.secret)).toBe(secretHash);
  });

  it('never embed the secret in the stored hash', () => {
    const { key, secretHash } = generateApiKey();
    const secret = parseApiKey(key)!.secret;
    expect(secretHash).not.toContain(secret);
    expect(secretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reject malformed tokens', () => {
    expect(parseApiKey('sk-openai-style')).toBeNull();
    expect(parseApiKey('gw_live_short_secret')).toBeNull();
    expect(parseApiKey(`gw_live_ABCDEFGH_${'a'.repeat(42)}!`)).toBeNull();
  });

  it('match only the original secret', () => {
    const hash = hashSecret('correct');
    expect(secretMatches('correct', hash)).toBe(true);
    expect(secretMatches('incorrect', hash)).toBe(false);
  });

  it('generate distinct values', () => {
    const values = new Set(Array.from({ length: 1000 }, () => randomBase62(8)));
    expect(values.size).toBe(1000);
  });
});
