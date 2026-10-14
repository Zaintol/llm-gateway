import type { ChatCompletionRequest } from '@gw/schema';
import { and, eq, gte, isNull, lt, sum } from 'drizzle-orm';
import { TtlCache } from '../auth/ttl-cache.js';
import { priceAt } from '../catalog/catalog.js';
import type { Db } from '../db/client.js';
import { budgets, usageEvents } from '../db/schema.js';
import { GatewayError } from '../errors.js';
import type { Candidate } from '../routing/planner.js';
import { estimatePromptTokens } from '../routing/tokens.js';
import type { BudgetLedger, CounterLimit } from './ledger.js';
import { counterKey, counterTtlSeconds, periodBounds, type Period } from './periods.js';

export type PeriodBudget = { hardLimitMicros: bigint | null; softLimitMicros: bigint | null };
export type TenantBudgets = Partial<Record<Period, PeriodBudget>>;

export interface BudgetSource {
  forTenant(tenantId: string): Promise<TenantBudgets>;
}

/** Tenant-level budgets from Postgres, cached briefly (changes apply within the TTL). */
export class PgBudgetSource implements BudgetSource {
  private readonly cache = new TtlCache<TenantBudgets>(10_000, 30_000);
  constructor(private readonly db: Db) {}

  async forTenant(tenantId: string): Promise<TenantBudgets> {
    const cached = this.cache.get(tenantId);
    if (cached) return cached;
    const rows = await this.db
      .select()
      .from(budgets)
      .where(and(eq(budgets.tenantId, tenantId), isNull(budgets.apiKeyId)));
    const result: TenantBudgets = {};
    for (const row of rows) {
      result[row.period] = {
        hardLimitMicros: row.hardLimitMicros,
        softLimitMicros: row.softLimitMicros,
      };
    }
    this.cache.set(tenantId, result);
    return result;
  }
}

const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d;
export const formatUsd = (micros: bigint) =>
  `$${(Number(micros) / 1_000_000).toFixed(micros < 10_000n ? 6 : 2)}`;

/**
 * Most a request could cost on a candidate: estimated prompt at the input price plus the full
 * output allowance (max_tokens, else the model's limit) at the output price, rounded up.
 */
export function worstCaseCostMicros(
  request: ChatCompletionRequest,
  candidate: Candidate,
  at: Date,
): bigint {
  const model = candidate.model;
  const price = model ? priceAt(model, at) : null;
  if (!model || !price) return 0n;
  const prompt = BigInt(estimatePromptTokens(request, candidate.provider));
  const output = BigInt(request.max_tokens ?? model.maxOutputTokens);
  return ceilDiv(
    prompt * price.inputPerMtokMicros + output * price.outputPerMtokMicros,
    1_000_000n,
  );
}

/** An open reservation for one request; settle it exactly once. */
export type Reservation = { requestId: string; counters: CounterLimit[]; reservedMicros: bigint };

export class BudgetService {
  constructor(
    private readonly ledger: BudgetLedger,
    private readonly source: BudgetSource,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  /**
   * Reserves `amount` against every hard-limited period of the tenant. Returns null when the tenant
   * has no hard limit (nothing to enforce). Throws 402 budget_exceeded, or 503 budget_unavailable
   * when the ledger cannot be reached for a tenant that has a hard limit (fail closed).
   */
  async reserve(input: {
    requestId: string;
    tenantId: string;
    at: Date;
    amountMicros: bigint;
  }): Promise<Reservation | null> {
    const tenantBudgets = await this.source.forTenant(input.tenantId);
    const counters: CounterLimit[] = [];
    for (const period of ['daily', 'monthly'] as const) {
      const hard = tenantBudgets[period]?.hardLimitMicros;
      if (hard === null || hard === undefined) continue;
      counters.push({
        key: counterKey(input.tenantId, period, input.at),
        hardLimitMicros: hard,
        ttlSeconds: counterTtlSeconds[period],
      });
    }
    if (counters.length === 0) return null;
    const reservation: Reservation = { requestId: input.requestId, counters, reservedMicros: 0n };
    await this.extend(reservation, input.amountMicros);
    return reservation;
  }

  /** Raises an open reservation to `totalMicros` (fallback to a pricier model). */
  async ensure(reservation: Reservation | null, totalMicros: bigint): Promise<void> {
    if (!reservation || totalMicros <= reservation.reservedMicros) return;
    await this.extend(reservation, totalMicros - reservation.reservedMicros);
  }

  private async extend(reservation: Reservation, amountMicros: bigint): Promise<void> {
    let result;
    try {
      result = await this.ledger.reserve(reservation.requestId, amountMicros, reservation.counters);
    } catch (err) {
      this.onError(err);
      throw new GatewayError(
        503,
        'internal',
        'budget_unavailable',
        'Budget enforcement is temporarily unavailable; try again shortly',
      );
    }
    if (!result.ok) {
      const period = result.counter.key.includes(':d:') ? 'Daily' : 'Monthly';
      throw new GatewayError(
        402,
        'budget_exceeded',
        'budget_exceeded',
        `${period} budget of ${formatUsd(result.counter.hardLimitMicros)} would be exceeded: ` +
          `${formatUsd(result.currentMicros)} already spent or reserved, this request may cost up to ${formatUsd(amountMicros)}`,
      );
    }
    reservation.reservedMicros += amountMicros;
  }

  /** Replaces the reservation with the actual cost. Never throws: the lease sweeper is the backstop. */
  async settle(reservation: Reservation | null, actualMicros: bigint): Promise<void> {
    if (!reservation) return;
    try {
      await this.ledger.settle(
        reservation.requestId,
        actualMicros,
        reservation.counters.map((c) => c.key),
      );
    } catch (err) {
      this.onError(err);
    }
  }
}

/**
 * Rebuilds the current period counters of every hard-budgeted tenant from usage_events, the source
 * of truth, keeping reservations still in flight. Events still in the metering queue are counted
 * at the next run.
 */
export async function reconcileBudgets(
  db: Db,
  ledger: BudgetLedger,
  at = new Date(),
): Promise<number> {
  const rows = await db.select().from(budgets).where(isNull(budgets.apiKeyId));
  let reconciled = 0;
  for (const row of rows) {
    if (row.hardLimitMicros === null) continue;
    const { start, end } = periodBounds(row.period, at);
    const [total] = await db
      .select({ spent: sum(usageEvents.costMicros) })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.tenantId, row.tenantId),
          gte(usageEvents.createdAt, start),
          lt(usageEvents.createdAt, end),
        ),
      );
    await ledger.reconcile(
      counterKey(row.tenantId, row.period, at),
      BigInt(total?.spent ?? '0'),
      counterTtlSeconds[row.period],
    );
    reconciled++;
  }
  return reconciled;
}
