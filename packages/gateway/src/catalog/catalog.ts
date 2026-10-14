import { asc } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { modelPrices, models, routingPolicies } from '../db/schema.js';

export type ModelPrice = {
  id: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  inputPerMtokMicros: bigint;
  outputPerMtokMicros: bigint;
  cachedInputPerMtokMicros: bigint | null;
};

export type CatalogModel = {
  id: string;
  provider: string;
  upstreamModel: string;
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: { tools: boolean; vision: boolean; jsonMode: boolean; streaming: boolean };
  qualityTier: number;
  latencyTier: 'fast' | 'standard' | 'slow';
  enabled: boolean;
  createdAt: Date;
  /** The price in effect when the catalog was loaded; null only if none is in effect. */
  price: ModelPrice | null;
  /** Every price row, oldest first. Use priceAt() to cost a request by its start time. */
  prices: ModelPrice[];
};

/** The price row in effect at `at`: effective_from <= at < effective_to. */
export function priceAt(model: Pick<CatalogModel, 'prices'>, at: Date): ModelPrice | null {
  const t = at.getTime();
  return (
    model.prices.find(
      (p) =>
        p.effectiveFrom.getTime() <= t && (p.effectiveTo === null || t < p.effectiveTo.getTime()),
    ) ?? null
  );
}

export type RoutingPolicy = {
  id: string;
  description: string;
  requirements: Record<string, unknown>;
  fallbackChain: string[];
  enabled: boolean;
};

export interface ModelCatalog {
  /** False until the first successful load; callers should answer 503 meanwhile. */
  readonly ready: boolean;
  getModel(id: string): CatalogModel | undefined;
  listModels(): CatalogModel[];
  getPolicy(id: string): RoutingPolicy | undefined;
}

export class StaticCatalog implements ModelCatalog {
  readonly ready = true;
  private readonly models: Map<string, CatalogModel>;
  private readonly policies: Map<string, RoutingPolicy>;

  constructor(models: CatalogModel[], policies: RoutingPolicy[] = []) {
    this.models = new Map(models.map((m) => [m.id, m]));
    this.policies = new Map(policies.map((p) => [p.id, p]));
  }

  getModel(id: string) {
    return this.models.get(id);
  }
  listModels() {
    return [...this.models.values()];
  }
  getPolicy(id: string) {
    return this.policies.get(id);
  }
}

/** Reads the catalog from Postgres into memory and refreshes it periodically. */
export class PgCatalog implements ModelCatalog {
  private snapshot: StaticCatalog | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Db,
    private readonly options: { refreshMs?: number; onError?: (err: unknown) => void } = {},
  ) {}

  get ready(): boolean {
    return this.snapshot !== null;
  }

  async refresh(): Promise<void> {
    const [modelRows, priceRows, policies] = await Promise.all([
      this.db.select().from(models),
      this.db.select().from(modelPrices).orderBy(asc(modelPrices.effectiveFrom)),
      this.db.select().from(routingPolicies),
    ]);
    const pricesByModel = new Map<string, ModelPrice[]>();
    for (const p of priceRows) {
      const list = pricesByModel.get(p.modelId) ?? [];
      list.push({
        id: p.id,
        effectiveFrom: p.effectiveFrom,
        effectiveTo: p.effectiveTo,
        inputPerMtokMicros: p.inputPricePerMtokMicros,
        outputPerMtokMicros: p.outputPricePerMtokMicros,
        cachedInputPerMtokMicros: p.cachedInputPricePerMtokMicros,
      });
      pricesByModel.set(p.modelId, list);
    }
    const now = new Date();
    this.snapshot = new StaticCatalog(
      modelRows.map((model) => {
        const prices = pricesByModel.get(model.id) ?? [];
        return {
          id: model.id,
          provider: model.provider,
          upstreamModel: model.upstreamModelName,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          capabilities: {
            tools: model.supportsTools,
            vision: model.supportsVision,
            jsonMode: model.supportsJsonMode,
            streaming: model.supportsStreaming,
          },
          qualityTier: model.qualityTier,
          latencyTier: model.latencyTier,
          enabled: model.enabled,
          createdAt: model.createdAt,
          prices,
          price: priceAt({ prices }, now),
        };
      }),
      policies.map((p) => ({
        id: p.id,
        description: p.description,
        requirements: p.requirements as Record<string, unknown>,
        fallbackChain: p.fallbackChain,
        enabled: p.enabled,
      })),
    );
  }

  /** Loads now (retrying in the background on failure) and keeps refreshing. */
  start(): void {
    const tick = () => this.refresh().catch((err: unknown) => this.options.onError?.(err));
    void tick();
    this.timer = setInterval(tick, this.options.refreshMs ?? 60_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  getModel(id: string) {
    return this.snapshot?.getModel(id);
  }
  listModels() {
    return this.snapshot?.listModels() ?? [];
  }
  getPolicy(id: string) {
    return this.snapshot?.getPolicy(id);
  }
}

export const microsToUsd = (micros: bigint | null) =>
  micros === null ? null : Number(micros) / 1_000_000;
