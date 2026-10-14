import { sql } from 'drizzle-orm';
import { PgCatalog, priceAt } from '../catalog/catalog.js';
import type { Db } from '../db/client.js';
import { usageEvents } from '../db/schema.js';
import { computeCostMicros } from '../metering/cost.js';
import { createApiKey, createTenant, findTenantBySlug, type Actor } from '../tenancy/service.js';

/** Small deterministic PRNG, so re-seeding produces identical events (and inserts nothing new). */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEMO_TENANTS = [
  { slug: 'acme', name: 'Acme Corp', volume: 1.0 },
  { slug: 'globex', name: 'Globex', volume: 0.55 },
  { slug: 'initech', name: 'Initech', volume: 0.25 },
];

/** Model mix by share of requests, with typical prompt and completion sizes. */
const MODEL_MIX = [
  { id: 'mock/fast', share: 0.42, prompt: 600, completion: 220 },
  { id: 'openai/gpt-4o-mini', share: 0.2, prompt: 1200, completion: 350 },
  { id: 'mock/smart', share: 0.14, prompt: 1800, completion: 500 },
  { id: 'anthropic/claude-haiku-4-5', share: 0.12, prompt: 1500, completion: 400 },
  { id: 'anthropic/claude-sonnet-4-5', share: 0.05, prompt: 3000, completion: 900 },
  { id: 'openai/gpt-4.1-nano', share: 0.04, prompt: 800, completion: 200 },
  { id: 'local/llama3.2', share: 0.03, prompt: 900, completion: 300 },
];

/** Busier in UTC working hours, quieter at weekends. */
const hourlyRate = (at: Date) => {
  const h = at.getUTCHours();
  const daytime = 0.25 + 0.75 * Math.max(0, Math.sin(((h - 6) / 14) * Math.PI));
  const weekend = at.getUTCDay() === 0 || at.getUTCDay() === 6 ? 0.45 : 1;
  return 10 * daytime * weekend;
};

export type DemoSeedReport = {
  tenants: Array<{ slug: string; id: string }>;
  events: number;
  apiKey?: string;
};

/**
 * Creates demo tenants and synthetic usage for the last `days` days, priced with the real catalog.
 * Writes usage_events directly; no provider is called.
 */
export async function seedDemo(
  db: Db,
  actor: Actor,
  days = 30,
  now = new Date(),
): Promise<DemoSeedReport> {
  const catalog = new PgCatalog(db);
  await catalog.refresh();
  const report: DemoSeedReport = { tenants: [], events: 0 };

  for (const [t, spec] of DEMO_TENANTS.entries()) {
    const tenant =
      (await findTenantBySlug(db, spec.slug)) ??
      (await createTenant(db, { slug: spec.slug, name: spec.name }, actor));
    report.tenants.push({ slug: spec.slug, id: tenant.id });
    if (t === 0 && !report.apiKey) {
      report.apiKey = (
        await createApiKey(db, { tenantId: tenant.id, name: 'demo-seed' }, actor)
      ).key;
    }
    const random = mulberry32(t + 1);
    const keyId = '00000000-0000-4000-8000-00000000d3a0';
    let batch: Array<typeof usageEvents.$inferInsert> = [];
    const flush = async () => {
      if (batch.length === 0) return;
      await db.insert(usageEvents).values(batch).onConflictDoNothing();
      report.events += batch.length;
      batch = [];
    };

    const start = Math.floor(now.getTime() / 3_600_000) * 3_600_000 - days * 86_400_000;
    for (let hour = start; hour < now.getTime(); hour += 3_600_000) {
      const at = new Date(hour);
      await db.execute(sql`select ensure_usage_events_partition(${at.toISOString()})`);
      const count = Math.round(hourlyRate(at) * spec.volume * (0.7 + random() * 0.6));
      for (let n = 0; n < count; n++) {
        let pick = random();
        const mix = MODEL_MIX.find((m) => (pick -= m.share) < 0) ?? MODEL_MIX[0]!;
        const model = catalog.getModel(mix.id);
        if (!model) continue;
        const createdAt = new Date(hour + Math.floor(random() * 3_600_000));
        const failed = random() < 0.012;
        const usage = {
          inputTokens: Math.round(mix.prompt * (0.4 + random() * 1.2)),
          outputTokens: Math.round(mix.completion * (0.3 + random() * 1.4)),
          cachedInputTokens: 0,
          source: 'provider' as const,
        };
        const price = priceAt(model, createdAt) ?? model.price;
        batch.push({
          requestId: `demo_${spec.slug}_${hour}_${n}`,
          tenantId: tenant.id,
          apiKeyId: keyId,
          requestedModel: random() < 0.3 ? 'auto' : mix.id,
          modelId: mix.id,
          provider: model.provider,
          priceId: price?.id ?? null,
          inputTokens: failed ? 0 : usage.inputTokens,
          outputTokens: failed ? 0 : usage.outputTokens,
          costMicros: failed || !price ? 0n : computeCostMicros(usage, price),
          usageSource: failed ? 'none' : 'provider',
          status: failed ? 'error' : 'success',
          attempts: failed ? 3 : random() < 0.04 ? 2 : 1,
          fallbackUsed: !failed && random() < 0.03,
          latencyMs: Math.round(300 + random() * 2500),
          routeReason: 'demo seed',
          createdAt,
        });
        if (batch.length >= 500) await flush();
      }
    }
    await flush();
  }
  // `events` counts rows attempted; re-runs insert nothing new thanks to the deterministic ids.
  return report;
}
