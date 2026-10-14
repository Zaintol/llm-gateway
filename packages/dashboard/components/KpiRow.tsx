import { formatCount, formatPercent, formatUsd } from '@/lib/format';
import type { Overview } from '@/lib/overview';

/** The hero spend figure leads; requests, average cost and fallback rate support it. */
export function KpiRow({ overview, periodLabel }: { overview: Overview; periodLabel: string }) {
  const { delta } = overview;
  return (
    <section className="kpis" aria-label="Summary">
      <div className="tile hero">
        <span className="label">Total spend</span>
        <span className="value" data-testid="total-spend">
          {formatUsd(overview.spendUsd)}
        </span>
        <span className="delta">
          {delta === null ? (
            'No spend in the previous period'
          ) : (
            <>
              {/* More spend is not good news, so increases are not shown in green. */}
              <span className={delta > 0 ? 'up' : delta < 0 ? 'down' : ''}>
                {formatPercent(delta, true)}
              </span>{' '}
              vs previous {periodLabel.replace(/^Last /, '').toLowerCase()}
            </>
          )}
        </span>
      </div>
      <div className="tile">
        <span className="label">Requests</span>
        <span className="value">{formatCount(overview.requests)}</span>
      </div>
      <div className="tile">
        <span className="label">Average cost per request</span>
        <span className="value">
          {overview.avgCostUsd === null ? '—' : formatUsd(overview.avgCostUsd)}
        </span>
      </div>
      <div className="tile">
        <span className="label">Served by a fallback model</span>
        <span className="value">
          {overview.fallbackRate === null ? '—' : formatPercent(overview.fallbackRate)}
        </span>
      </div>
    </section>
  );
}
