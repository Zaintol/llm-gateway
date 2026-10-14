/** Money at a precision that suits its size: $1,284.50 · $12.37 · $0.0042 · $0.000008. */
export function formatUsd(value: number): string {
  if (value === 0) return '$0';
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Compact counts: 1,284 · 12.9K · 4.2M. */
export function formatCount(value: number): string {
  return value < 10_000
    ? value.toLocaleString('en-US')
    : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
        value,
      );
}

export function formatPercent(value: number, signed = false): string {
  const pct = `${(Math.abs(value) * 100).toFixed(Math.abs(value) < 0.1 ? 1 : 0)}%`;
  if (!signed) return pct;
  return value > 0 ? `+${pct}` : value < 0 ? `−${pct}` : pct;
}

export function formatBucket(start: string, bucket: 'hour' | 'day'): string {
  const d = new Date(start);
  return bucket === 'hour'
    ? d.toLocaleString('en-US', { hour: 'numeric', timeZone: 'UTC' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Axis tick: just enough decimals to tell the steps apart ($0, $0.1, $0.2 · $0, $250, $500). */
export function formatTick(value: number, step: number): string {
  const decimals = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step) - 1e-9));
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
