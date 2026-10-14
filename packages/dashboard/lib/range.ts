/** Time range for the overview, plus the equal-length period before it for the delta. */
export type Range = {
  key: '24h' | '7d' | '30d' | 'custom';
  label: string;
  from: Date;
  to: Date;
  prevFrom: Date;
  bucket: 'hour' | 'day';
};

export const PRESETS = [
  { key: '24h', label: 'Last 24 hours' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
] as const;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The admin usage API aggregates raw events, capped at 31 days per query. */
export const MAX_CUSTOM_DAYS = 31;

const startOfHour = (t: number) => Math.floor(t / HOUR) * HOUR;
const startOfDay = (t: number) => Math.floor(t / DAY) * DAY;

export function parseRange(
  params: Record<string, string | string[] | undefined>,
  now = new Date(),
): { range: Range; error?: string } {
  const key = typeof params.range === 'string' ? params.range : '7d';
  if (key === 'custom') {
    const from = typeof params.from === 'string' ? Date.parse(`${params.from}T00:00:00Z`) : NaN;
    const to = typeof params.to === 'string' ? Date.parse(`${params.to}T00:00:00Z`) + DAY : NaN;
    const span = to - from;
    if (Number.isFinite(span) && span > 0 && span <= MAX_CUSTOM_DAYS * DAY) {
      return {
        range: {
          key,
          label: `${params.from} to ${params.to}`,
          from: new Date(from),
          to: new Date(to),
          prevFrom: new Date(from - span),
          bucket: 'day',
        },
      };
    }
    const fallback = parseRange({ range: '7d' }, now).range;
    return { range: fallback, error: `Pick a custom range of 1 to ${MAX_CUSTOM_DAYS} days` };
  }
  if (key === '24h') {
    const to = startOfHour(now.getTime()) + HOUR;
    return {
      range: {
        key,
        label: 'Last 24 hours',
        from: new Date(to - DAY),
        to: new Date(to),
        prevFrom: new Date(to - 2 * DAY),
        bucket: 'hour',
      },
    };
  }
  const days = key === '30d' ? 30 : 7;
  const to = startOfDay(now.getTime()) + DAY;
  return {
    range: {
      key: key === '30d' ? '30d' : '7d',
      label: days === 30 ? 'Last 30 days' : 'Last 7 days',
      from: new Date(to - days * DAY),
      to: new Date(to),
      prevFrom: new Date(to - 2 * days * DAY),
      bucket: 'day',
    },
  };
}

/** Every bucket start in [from, to) as the ISO strings the usage API returns. */
export function bucketStarts(range: Range): string[] {
  const step = range.bucket === 'hour' ? HOUR : DAY;
  const out: string[] = [];
  for (let t = range.from.getTime(); t < range.to.getTime(); t += step)
    out.push(`${new Date(t).toISOString().slice(0, 19)}Z`);
  return out;
}
