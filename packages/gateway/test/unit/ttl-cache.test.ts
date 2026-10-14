import { describe, expect, it } from 'vitest';
import { TtlCache } from '../../src/auth/ttl-cache.js';

describe('TtlCache', () => {
  it('expires entries after the ttl', () => {
    let now = 0;
    const cache = new TtlCache<string>(10, 1000, () => now);
    cache.set('a', 'value');
    now = 999;
    expect(cache.get('a')).toBe('value');
    now = 1000;
    expect(cache.get('a')).toBeUndefined();
  });

  it('evicts the oldest entry when full', () => {
    const cache = new TtlCache<number>(2, 60_000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.size).toBe(2);
  });
});
