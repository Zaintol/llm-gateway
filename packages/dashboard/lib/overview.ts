import { bucketStarts, type Range } from './range';

/** A row from GET /admin/v1/usage. */
export type UsageRow = {
  period?: string;
  model?: string;
  tenant_id?: string;
  requests: number;
  errors: number;
  fallbacks: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
};

/** Categorical slots in fixed order (validated light and dark); see globals.css --series-N. */
export const SERIES_SLOTS = 6;
/** Charted models; everything past these folds into "Other". */
export const MAX_MODELS = 5;

export type Series = { id: string; label: string; color: string };
export type Bucket = { start: string; values: Record<string, number>; total: number };
export type TenantRow = {
  id: string;
  name: string;
  requests: number;
  spendUsd: number;
  avgCostUsd: number | null;
};

export type Overview = {
  spendUsd: number;
  prevSpendUsd: number;
  /** Change versus the previous period, as a fraction; null when there was no previous spend. */
  delta: number | null;
  requests: number;
  avgCostUsd: number | null;
  fallbackRate: number | null;
  series: Series[];
  buckets: Bucket[];
  tenants: TenantRow[];
  empty: boolean;
};

const sum = (rows: UsageRow[], pick: (r: UsageRow) => number) =>
  rows.reduce((acc, r) => acc + pick(r), 0);
/** Floating sums of micro-USD values: round to the micro so totals match the API exactly. */
const usd = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

/**
 * Colour follows the model, never its rank: a model's slot comes from its position in the
 * stable catalog order, so filtering the range never repaints the survivors.
 */
export function colorFor(model: string, catalogOrder: string[], taken: Set<number>): string {
  const index = Math.max(0, catalogOrder.indexOf(model));
  let slot = index % SERIES_SLOTS;
  for (let i = 0; i < SERIES_SLOTS && taken.has(slot); i++) slot = (slot + 1) % SERIES_SLOTS;
  taken.add(slot);
  return `var(--series-${slot + 1})`;
}

export function buildOverview(input: {
  range: Range;
  /** Grouped by the range bucket and model. */
  current: UsageRow[];
  /** Any grouping; only the total is used. */
  previous: UsageRow[];
  /** Grouped by tenant. */
  byTenant: UsageRow[];
  tenantNames: Record<string, string>;
  catalogOrder: string[];
}): Overview {
  const { current } = input;
  const spendUsd = usd(sum(current, (r) => r.cost_usd));
  const prevSpendUsd = usd(sum(input.previous, (r) => r.cost_usd));
  const requests = sum(current, (r) => r.requests);

  const spendByModel = new Map<string, number>();
  for (const r of current)
    spendByModel.set(
      r.model ?? 'unknown',
      (spendByModel.get(r.model ?? 'unknown') ?? 0) + r.cost_usd,
    );
  const ranked = [...spendByModel.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const charted = ranked.slice(0, MAX_MODELS).map(([m]) => m);
  const hasOther = ranked.length > MAX_MODELS;

  const taken = new Set<number>();
  const series: Series[] = charted.map((id) => ({
    id,
    label: id,
    color: colorFor(id, input.catalogOrder, taken),
  }));
  if (hasOther) series.push({ id: '__other', label: 'Other', color: 'var(--series-other)' });

  const byBucket = new Map<string, Bucket>(
    bucketStarts(input.range).map((start) => [start, { start, values: {}, total: 0 }]),
  );
  for (const r of current) {
    const bucket = r.period ? byBucket.get(r.period) : undefined;
    if (!bucket) continue;
    const id = charted.includes(r.model ?? '') ? r.model! : '__other';
    if (r.cost_usd === 0 && id === '__other') continue;
    bucket.values[id] = usd((bucket.values[id] ?? 0) + r.cost_usd);
    bucket.total = usd(bucket.total + r.cost_usd);
  }

  const tenants: TenantRow[] = input.byTenant
    .map((r) => ({
      id: r.tenant_id ?? 'unknown',
      name: input.tenantNames[r.tenant_id ?? ''] ?? r.tenant_id ?? 'unknown',
      requests: r.requests,
      spendUsd: usd(r.cost_usd),
      avgCostUsd: r.requests ? r.cost_usd / r.requests : null,
    }))
    .sort((a, b) => b.spendUsd - a.spendUsd || a.name.localeCompare(b.name));

  return {
    spendUsd,
    prevSpendUsd,
    delta: prevSpendUsd > 0 ? (spendUsd - prevSpendUsd) / prevSpendUsd : null,
    requests,
    avgCostUsd: requests ? spendUsd / requests : null,
    fallbackRate: requests ? sum(current, (r) => r.fallbacks) / requests : null,
    series,
    buckets: [...byBucket.values()],
    tenants,
    empty: requests === 0,
  };
}
