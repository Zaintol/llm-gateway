import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, isNull, notInArray } from 'drizzle-orm';
import { createDb, createPool, type Db } from '../db/client.js';
import { modelPrices, models, routingPolicies } from '../db/schema.js';
import {
  CatalogDefinitionError,
  loadCatalogFile,
  providerOf,
  usdToMicros,
  type CatalogDefinition,
} from './definition.js';

export type SeedReport = {
  models: number;
  pricesInserted: number;
  pricesClosed: number;
  disabled: string[];
};

/**
 * Syncs the database with the catalog definition. Model metadata is updated in place; prices are
 * append-only (a change closes the open row and inserts a new one); models removed from the
 * file are disabled, never deleted, because usage events still reference them.
 */
export async function seedCatalog(
  db: Db,
  catalog: CatalogDefinition,
  now = new Date(),
): Promise<SeedReport> {
  return db.transaction(async (tx) => {
    const report: SeedReport = {
      models: catalog.models.length,
      pricesInserted: 0,
      pricesClosed: 0,
      disabled: [],
    };

    for (const model of catalog.models) {
      const values = {
        provider: providerOf(model.id),
        upstreamModelName: model.upstream_model,
        contextWindow: model.context_window,
        maxOutputTokens: model.max_output_tokens,
        supportsTools: model.capabilities.tools,
        supportsVision: model.capabilities.vision,
        supportsJsonMode: model.capabilities.json_mode,
        supportsStreaming: model.capabilities.streaming,
        qualityTier: model.quality_tier,
        latencyTier: model.latency_tier,
        enabled: model.enabled,
      };
      await tx
        .insert(models)
        .values({ id: model.id, ...values })
        .onConflictDoUpdate({ target: models.id, set: values });

      const price = {
        inputPricePerMtokMicros: usdToMicros(model.price.input_per_mtok_usd),
        outputPricePerMtokMicros: usdToMicros(model.price.output_per_mtok_usd),
        cachedInputPricePerMtokMicros:
          model.price.cached_input_per_mtok_usd === undefined
            ? null
            : usdToMicros(model.price.cached_input_per_mtok_usd),
      };
      const [open] = await tx
        .select()
        .from(modelPrices)
        .where(and(eq(modelPrices.modelId, model.id), isNull(modelPrices.effectiveTo)))
        .for('update');
      const unchanged =
        open &&
        open.inputPricePerMtokMicros === price.inputPricePerMtokMicros &&
        open.outputPricePerMtokMicros === price.outputPricePerMtokMicros &&
        open.cachedInputPricePerMtokMicros === price.cachedInputPricePerMtokMicros;
      if (unchanged) continue;

      // A new price takes effect at its declared date, but never before the price it replaces.
      let effectiveFrom = model.price.effective_from;
      if (open && effectiveFrom <= open.effectiveFrom)
        effectiveFrom = now > open.effectiveFrom ? now : new Date(open.effectiveFrom.getTime() + 1);
      if (open) {
        await tx
          .update(modelPrices)
          .set({ effectiveTo: effectiveFrom })
          .where(eq(modelPrices.id, open.id));
        report.pricesClosed++;
      }
      await tx.insert(modelPrices).values({
        modelId: model.id,
        ...price,
        currency: 'USD',
        effectiveFrom,
        sourceUrl: model.price.source_url,
        recordedAt: now,
      });
      report.pricesInserted++;
    }

    const ids = catalog.models.map((m) => m.id);
    const disabled = await tx
      .update(models)
      .set({ enabled: false })
      .where(and(notInArray(models.id, ids), eq(models.enabled, true)))
      .returning({ id: models.id });
    report.disabled = disabled.map((d) => d.id);

    for (const policy of catalog.routingPolicies) {
      const values = {
        description: policy.description,
        requirements: policy.requirements,
        fallbackChain: policy.fallback_chain,
        enabled: policy.enabled,
      };
      await tx
        .insert(routingPolicies)
        .values({ id: policy.id, ...values })
        .onConflictDoUpdate({ target: routingPolicies.id, set: values });
    }
    const policyIds = catalog.routingPolicies.map((p) => p.id);
    await tx
      .update(routingPolicies)
      .set({ enabled: false })
      .where(policyIds.length ? notInArray(routingPolicies.id, policyIds) : undefined);
    return report;
  });
}

// One-off command: `pnpm seed:catalog [path/to/models.yaml]`.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  let catalog: CatalogDefinition;
  try {
    catalog = loadCatalogFile(process.argv[2]);
  } catch (err) {
    console.error(
      err instanceof CatalogDefinitionError
        ? err.message
        : `Could not read catalog: ${String(err)}`,
    );
    process.exit(1);
  }
  const pool = createPool(databaseUrl);
  try {
    const report = await seedCatalog(createDb(pool), catalog);
    console.log(
      `catalog seeded: ${report.models} models, ${report.pricesInserted} price rows inserted, ${report.pricesClosed} closed` +
        (report.disabled.length ? `, disabled: ${report.disabled.join(', ')}` : ''),
    );
  } catch (err) {
    console.error('catalog seed failed', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
