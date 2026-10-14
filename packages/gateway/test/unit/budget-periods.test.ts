import { describe, expect, it } from 'vitest';
import { counterKey, periodBounds } from '../../src/budget/periods.js';

describe('budget periods (UTC)', () => {
  it('counts a request at 00:00:05 UTC on the 1st against the new day and month', () => {
    const at = new Date('2026-11-01T00:00:05Z');
    expect(counterKey('t', 'daily', at)).toBe('gw:budget:t:d:20261101');
    expect(counterKey('t', 'monthly', at)).toBe('gw:budget:t:m:202611');
    const justBefore = new Date('2026-10-31T23:59:59Z');
    expect(counterKey('t', 'daily', justBefore)).toBe('gw:budget:t:d:20261031');
    expect(counterKey('t', 'monthly', justBefore)).toBe('gw:budget:t:m:202610');
  });

  it('computes half-open period bounds, including year rollover', () => {
    expect(periodBounds('monthly', new Date('2026-12-15T12:00:00Z'))).toEqual({
      start: new Date('2026-12-01T00:00:00Z'),
      end: new Date('2027-01-01T00:00:00Z'),
    });
    expect(periodBounds('daily', new Date('2026-12-31T23:59:59Z'))).toEqual({
      start: new Date('2026-12-31T00:00:00Z'),
      end: new Date('2027-01-01T00:00:00Z'),
    });
  });
});
