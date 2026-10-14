import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { KpiRow } from '@/components/KpiRow';
import { SpendChart } from '@/components/SpendChart';
import { TenantTable } from '@/components/TenantTable';
import { buildOverview, type UsageRow } from '@/lib/overview';
import { parseRange } from '@/lib/range';

const now = new Date('2026-10-14T15:30:00Z');
const { range } = parseRange({ range: '7d' }, now);
const row = (
  period: string,
  model: string,
  cost: number,
  extra: Partial<UsageRow> = {},
): UsageRow => ({
  period,
  model,
  requests: 10,
  errors: 0,
  fallbacks: 1,
  input_tokens: 100,
  output_tokens: 50,
  cost_usd: cost,
  ...extra,
});
const catalogOrder = [
  'anthropic/claude',
  'mock/fast',
  'mock/smart',
  'openai/a',
  'openai/b',
  'openai/c',
  'openai/d',
];

describe('buildOverview', () => {
  const current = [
    row('2026-10-09T00:00:00Z', 'mock/fast', 0.000123),
    row('2026-10-09T00:00:00Z', 'mock/smart', 0.25),
    row('2026-10-12T00:00:00Z', 'anthropic/claude', 1.1),
  ];

  it('makes the total spend KPI equal the sum returned by the usage API for the range', () => {
    const overview = buildOverview({
      range,
      current,
      previous: [],
      byTenant: [],
      tenantNames: {},
      catalogOrder,
    });
    expect(overview.spendUsd).toBe(1.350123);
    expect(overview.requests).toBe(30);
    expect(overview.fallbackRate).toBeCloseTo(0.1);
    expect(renderToString(<KpiRow overview={overview} periodLabel={range.label} />)).toContain(
      '$1.35',
    );
  });

  it('reports the change versus the previous period', () => {
    const overview = buildOverview({
      range,
      current,
      previous: [row('2026-10-01T00:00:00Z', 'mock/fast', 0.9)],
      byTenant: [],
      tenantNames: {},
      catalogOrder,
    });
    expect(overview.delta).toBeCloseTo(0.5001, 3);
  });

  it('fills every day in the range, including days without usage', () => {
    const overview = buildOverview({
      range,
      current,
      previous: [],
      byTenant: [],
      tenantNames: {},
      catalogOrder,
    });
    expect(overview.buckets.map((b) => b.start)).toEqual([
      '2026-10-08T00:00:00Z',
      '2026-10-09T00:00:00Z',
      '2026-10-10T00:00:00Z',
      '2026-10-11T00:00:00Z',
      '2026-10-12T00:00:00Z',
      '2026-10-13T00:00:00Z',
      '2026-10-14T00:00:00Z',
    ]);
    expect(overview.buckets[1]!.values).toEqual({ 'mock/fast': 0.000123, 'mock/smart': 0.25 });
  });

  it('keeps each model on the same colour whatever its rank in the range', () => {
    const a = buildOverview({
      range,
      current,
      previous: [],
      byTenant: [],
      tenantNames: {},
      catalogOrder,
    });
    const b = buildOverview({
      range,
      current: current.slice(1),
      previous: [],
      byTenant: [],
      tenantNames: {},
      catalogOrder,
    });
    const color = (o: typeof a, id: string) => o.series.find((s) => s.id === id)!.color;
    expect(color(a, 'mock/smart')).toBe(color(b, 'mock/smart'));
    expect(color(a, 'anthropic/claude')).toBe(color(b, 'anthropic/claude'));
  });

  it('folds models beyond the top five into Other', () => {
    const many = catalogOrder.map((m, i) => row('2026-10-10T00:00:00Z', m, (i + 1) / 10));
    const overview = buildOverview({
      range,
      current: many,
      previous: [],
      byTenant: [],
      tenantNames: {},
      catalogOrder,
    });
    expect(overview.series.map((s) => s.label)).toEqual([
      'openai/d',
      'openai/c',
      'openai/b',
      'openai/a',
      'mock/smart',
      'Other',
    ]);
    expect(overview.buckets[2]!.values.__other).toBeCloseTo(0.3);
  });

  it('lists only the tenants the scoped usage API returned', () => {
    const overview = buildOverview({
      range,
      current,
      previous: [],
      byTenant: [
        {
          tenant_id: 't-acme',
          requests: 30,
          errors: 0,
          fallbacks: 3,
          input_tokens: 1,
          output_tokens: 1,
          cost_usd: 1.35,
        },
      ],
      tenantNames: { 't-acme': 'Acme Corp', 't-globex': 'Globex' },
      catalogOrder,
    });
    const html = renderToString(<TenantTable rows={overview.tenants} />);
    expect(html).toContain('Acme Corp');
    expect(html).not.toContain('Globex');
  });
});

describe('SpendChart', () => {
  it('shows an empty-state message instead of an empty axis when the range has no usage', () => {
    const overview = buildOverview({
      range,
      current: [],
      previous: [],
      byTenant: [],
      tenantNames: {},
      catalogOrder,
    });
    expect(overview.empty).toBe(true);
    const html = renderToString(
      <SpendChart series={overview.series} buckets={overview.buckets} bucket="day" />,
    );
    expect(html).toContain('No usage in this range');
    expect(html).not.toContain('<svg');
  });

  it('renders a legend, a table view and no mutating controls', () => {
    const overview = buildOverview({
      range,
      current: [
        row('2026-10-09T00:00:00Z', 'mock/fast', 0.5),
        row('2026-10-09T00:00:00Z', 'mock/smart', 0.25),
      ],
      previous: [],
      byTenant: [],
      tenantNames: {},
      catalogOrder,
    });
    const html = renderToString(
      <>
        <KpiRow overview={overview} periodLabel={range.label} />
        <SpendChart series={overview.series} buckets={overview.buckets} bucket="day" />
        <TenantTable rows={overview.tenants} />
      </>,
    );
    expect(html).toContain('aria-label="Models"');
    expect(html).toContain('View as table');
    expect(html).not.toMatch(/method="post"|<form/i);
  });
});

describe('parseRange', () => {
  it('builds hourly buckets for 24 hours and daily buckets otherwise', () => {
    expect(parseRange({ range: '24h' }, now).range).toMatchObject({
      bucket: 'hour',
      from: new Date('2026-10-13T16:00:00Z'),
      to: new Date('2026-10-14T16:00:00Z'),
    });
    expect(parseRange({ range: '30d' }, now).range.bucket).toBe('day');
  });

  it('accepts a custom range of up to 31 days and rejects longer ones', () => {
    expect(
      parseRange({ range: 'custom', from: '2026-09-01', to: '2026-09-30' }, now).error,
    ).toBeUndefined();
    const tooLong = parseRange({ range: 'custom', from: '2026-01-01', to: '2026-03-01' }, now);
    expect(tooLong.error).toMatch(/1 to 31 days/);
    expect(tooLong.range.key).toBe('7d');
  });
});
