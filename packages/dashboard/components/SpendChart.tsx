'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { formatBucket, formatTick, formatUsd } from '@/lib/format';
import type { Bucket, Series } from '@/lib/overview';

const HEIGHT = 280;
const MARGIN = { top: 12, right: 12, bottom: 28, left: 64 };
const GAP = 2; // surface gap between stacked segments
const RADIUS = 4; // rounded data-end, square at the baseline

/** Rounds the axis maximum up to a clean 1/2/5 × 10^n step. */
function niceMax(value: number): { max: number; step: number } {
  if (value <= 0) return { max: 1, step: 0.25 };
  const rough = value / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough)!;
  return { max: step * Math.ceil(value / step), step };
}

/** Column path with rounded top corners only. */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function SpendChart({
  series,
  buckets,
  bucket,
}: {
  series: Series[];
  buckets: Bucket[];
  bucket: 'hour' | 'day';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [active, setActive] = useState<number | null>(null);

  // Measure before the first paint, then follow the container. ResizeObserver alone can deliver
  // its first callback late (e.g. in a background tab), leaving the chart at the default width.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = (w: number) => setWidth(Math.max(280, Math.floor(w)));
    fit(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => fit(entry!.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const total = buckets.reduce((acc, b) => acc + b.total, 0);
  if (total === 0) {
    return (
      <div className="empty" role="status">
        <strong>No usage in this range</strong>
        <span>Requests appear here within a few seconds of being served.</span>
      </div>
    );
  }

  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const { max, step } = niceMax(Math.max(...buckets.map((b) => b.total)));
  const y = (v: number) => MARGIN.top + plotH - (v / max) * plotH;
  const band = plotW / buckets.length;
  const barW = Math.max(2, Math.min(24, band * 0.7));
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(2, Math.floor(plotW / 72))));
  const hovered = active === null ? null : buckets[active]!;

  return (
    <div className="chart" ref={ref}>
      <ul className="legend" aria-label="Models">
        {series.map((s) => (
          <li key={s.id}>
            <svg width="12" height="12" aria-hidden="true">
              <rect width="12" height="12" rx="2" fill={s.color} />
            </svg>
            {s.label}
          </li>
        ))}
      </ul>
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label="Spend by model over time"
        onMouseLeave={() => setActive(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={y(t)}
              y2={y(t)}
              className={t === 0 ? 'axis' : 'grid'}
            />
            <text x={MARGIN.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="tick">
              {formatTick(t, step)}
            </text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const x = MARGIN.left + i * band + (band - barW) / 2;
          let base = 0;
          const stack = series.filter((s) => (b.values[s.id] ?? 0) > 0);
          return (
            <g key={b.start} className={active !== null && active !== i ? 'dim' : undefined}>
              {stack.map((s, j) => {
                const value = b.values[s.id]!;
                const top = y(base + value);
                const bottom = y(base);
                base += value;
                const h = bottom - top - (j > 0 ? GAP : 0);
                if (h <= 0) return null;
                const isTop = j === stack.length - 1;
                return isTop ? (
                  <path key={s.id} d={topRounded(x, top, barW, h, RADIUS)} fill={s.color} />
                ) : (
                  <rect key={s.id} x={x} y={top} width={barW} height={h} fill={s.color} />
                );
              })}
              {i % labelEvery === 0 && (
                <text x={x + barW / 2} y={HEIGHT - 8} textAnchor="middle" className="tick">
                  {formatBucket(b.start, bucket)}
                </text>
              )}
              {/* The hit target is the whole band, not the painted column. */}
              <rect
                x={MARGIN.left + i * band}
                y={MARGIN.top}
                width={band}
                height={plotH}
                fill="transparent"
                tabIndex={0}
                aria-label={`${formatBucket(b.start, bucket)}: ${formatUsd(b.total)}`}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              />
            </g>
          );
        })}
      </svg>
      {hovered && (
        <div
          className="tooltip"
          style={{
            left: Math.min(width - 260, Math.max(0, MARGIN.left + active! * band + band / 2 - 130)),
          }}
          role="tooltip"
        >
          <div className="tooltip-title">{formatBucket(hovered.start, bucket)}</div>
          {series
            .filter((s) => hovered.values[s.id])
            .map((s) => (
              <div key={s.id} className="tooltip-row">
                <span className="key" style={{ background: s.color }} />
                <strong>{formatUsd(hovered.values[s.id]!)}</strong>
                <span className="muted">{s.label}</span>
              </div>
            ))}
          <div className="tooltip-row total">
            <strong>{formatUsd(hovered.total)}</strong>
            <span className="muted">Total</span>
          </div>
        </div>
      )}
      <details className="table-view">
        <summary>View as table</summary>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{bucket === 'hour' ? 'Hour (UTC)' : 'Day (UTC)'}</th>
                {series.map((s) => (
                  <th key={s.id} scope="col" className="num">
                    {s.label}
                  </th>
                ))}
                <th scope="col" className="num">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.start}>
                  <th scope="row">{formatBucket(b.start, bucket)}</th>
                  {series.map((s) => (
                    <td key={s.id} className="num">
                      {formatUsd(b.values[s.id] ?? 0)}
                    </td>
                  ))}
                  <td className="num">{formatUsd(b.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
