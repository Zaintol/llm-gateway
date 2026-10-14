import { and, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { usageEvents } from '../db/schema.js';
import { GatewayError } from '../errors.js';

/** MVP aggregates raw events, so ranges are capped; hourly rollups (GW-7.3) lift this to 400 days. */
export const MAX_RANGE_DAYS = 31;
export const GROUP_BY = ['hour', 'day', 'tenant', 'key', 'model', 'provider'] as const;
export type GroupBy = (typeof GROUP_BY)[number];

export const usageQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  group_by: z
    .string()
    .default('day')
    .transform((v, ctx) => {
      const parts = v
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const bad = parts.filter((p) => !(GROUP_BY as readonly string[]).includes(p));
      if (bad.length || parts.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: `group_by must be a comma list of ${GROUP_BY.join(', ')}`,
        });
        return z.NEVER;
      }
      if (parts.includes('hour') && parts.includes('day')) {
        ctx.addIssue({ code: 'custom', message: 'group_by cannot combine hour and day' });
        return z.NEVER;
      }
      return [...new Set(parts)] as GroupBy[];
    }),
  tenant_id: z.uuid().optional(),
});

export type UsageRow = {
  period?: string;
  tenant_id?: string;
  key_id?: string;
  model?: string;
  provider?: string;
  requests: number;
  errors: number;
  fallbacks: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
};

/** UTC bucket start rendered as ISO 8601, e.g. 2026-10-10T00:00:00Z. */
function isoPeriod(unit: 'hour' | 'day'): SQL {
  return sql`to_char(date_trunc(${sql.raw(`'${unit}'`)}, ${usageEvents.createdAt} at time zone 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;
}

const dimension: Record<GroupBy, { column: SQL; alias: keyof UsageRow }> = {
  hour: { column: isoPeriod('hour'), alias: 'period' },
  day: { column: isoPeriod('day'), alias: 'period' },
  tenant: { column: sql`${usageEvents.tenantId}`, alias: 'tenant_id' },
  key: { column: sql`${usageEvents.apiKeyId}`, alias: 'key_id' },
  model: { column: sql`${usageEvents.modelId}`, alias: 'model' },
  provider: { column: sql`${usageEvents.provider}`, alias: 'provider' },
};

/** Spend and volume over [from, to), grouped by the requested dimensions. */
export async function queryUsage(
  db: Db,
  input: { from: Date; to: Date; groupBy: GroupBy[]; tenantId?: string },
): Promise<UsageRow[]> {
  if (input.to <= input.from)
    throw new GatewayError(400, 'invalid_request', 'invalid_range', '`to` must be after `from`');
  if (input.to.getTime() - input.from.getTime() > MAX_RANGE_DAYS * 86_400_000) {
    throw new GatewayError(
      400,
      'invalid_request',
      'range_too_large',
      `The maximum range is ${MAX_RANGE_DAYS} days`,
    );
  }
  const dims = input.groupBy.map((g) => dimension[g]);
  const selected = Object.fromEntries(dims.map((d) => [d.alias, d.column]));
  const conditions = [gte(usageEvents.createdAt, input.from), lt(usageEvents.createdAt, input.to)];
  if (input.tenantId) conditions.push(eq(usageEvents.tenantId, input.tenantId));

  const rows = await db
    .select({
      ...selected,
      requests: sql<string>`count(*)`,
      errors: sql<string>`count(*) filter (where ${usageEvents.status} = 'error')`,
      fallbacks: sql<string>`count(*) filter (where ${usageEvents.fallbackUsed})`,
      input_tokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
      output_tokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
      cost_micros: sql<string>`coalesce(sum(${usageEvents.costMicros}), 0)`,
    })
    .from(usageEvents)
    .where(and(...conditions))
    .groupBy(...dims.map((d) => d.column))
    .orderBy(...dims.map((d) => d.column));

  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    const out: UsageRow = {
      requests: Number(row.requests),
      errors: Number(row.errors),
      fallbacks: Number(row.fallbacks),
      input_tokens: Number(row.input_tokens),
      output_tokens: Number(row.output_tokens),
      cost_usd: Number(BigInt(row.cost_micros as string)) / 1_000_000,
    };
    for (const d of dims) {
      const value = row[d.alias];
      (out as Record<string, unknown>)[d.alias] =
        value instanceof Date ? `${value.toISOString().slice(0, 19)}Z` : String(value);
    }
    return out;
  });
}

/** CSV with a header row matching the JSON field names. */
export function toCsv(rows: UsageRow[], groupBy: GroupBy[]): string {
  const keys = [...new Set(groupBy.map((g) => dimension[g].alias))];
  const fields = [
    ...keys,
    'requests',
    'errors',
    'fallbacks',
    'input_tokens',
    'output_tokens',
    'cost_usd',
  ] as const;
  const escape = (v: unknown) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return (
    [
      fields.join(','),
      ...rows.map((r) => fields.map((f) => escape((r as Record<string, unknown>)[f])).join(',')),
    ].join('\n') + '\n'
  );
}
