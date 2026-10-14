import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { modelPrices, models, routingPolicies } from '../db/schema.js';

export type ModelPrice = {
  id: string;
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
  /** The currently effective price; null only if the catalog was never seeded with one. */
  price: ModelPrice | null;
};

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
    const rows = await this.db
      .select({ model: models, price: modelPrices })
      .from(models)
      .leftJoin(
        modelPrices,
        and(eq(modelPrices.modelId, models.id), isNull(modelPrices.effectiveTo)),
      );
    const policies = await this.db.select().from(routingPolicies);
    this.snapshot = new StaticCatalog(
      rows.map(({ model, price }) => ({
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
        price: price
          ? {
              id: price.id,
              inputPerMtokMicros: price.inputPricePerMtokMicros,
              outputPerMtokMicros: price.outputPricePerMtokMicros,
              cachedInputPerMtokMicros: price.cachedInputPricePerMtokMicros,
            }
          : null,
      })),
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
