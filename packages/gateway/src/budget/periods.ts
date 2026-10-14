export type Period = 'daily' | 'monthly';

const pad = (n: number) => String(n).padStart(2, '0');

/** UTC period identifiers for a timestamp, e.g. daily 20261014 and monthly 202610. */
export function periodIds(at: Date): Record<Period, string> {
  const y = at.getUTCFullYear();
  const m = pad(at.getUTCMonth() + 1);
  return { daily: `${y}${m}${pad(at.getUTCDate())}`, monthly: `${y}${m}` };
}

/** Redis counter holding settled spend plus open reservations, in micro-USD. */
export function counterKey(tenantId: string, period: Period, at: Date): string {
  return `gw:budget:${tenantId}:${period === 'daily' ? 'd' : 'm'}:${periodIds(at)[period]}`;
}

/** [start, end) of the UTC period containing `at`. */
export function periodBounds(period: Period, at: Date): { start: Date; end: Date } {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  if (period === 'monthly')
    return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
  const d = at.getUTCDate();
  return { start: new Date(Date.UTC(y, m, d)), end: new Date(Date.UTC(y, m, d + 1)) };
}

/** Counters outlive their period a little so late settlements still land. */
export const counterTtlSeconds: Record<Period, number> = {
  daily: 2 * 86_400,
  monthly: 35 * 86_400,
};
