import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

/** catalog/models.yaml, valid from both `src/catalog` and `dist/catalog`. */
export const defaultCatalogPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../catalog/models.yaml',
);

/** USD per million tokens to integer micro-USD, refusing sub-micro precision. */
export function usdToMicros(usd: number): bigint {
  const micros = Math.round(usd * 1_000_000);
  if (Math.abs(usd * 1_000_000 - micros) > 1e-6) {
    throw new Error(`${usd} USD has more precision than one micro-USD`);
  }
  return BigInt(micros);
}

const usd = z.number().min(0);

const priceSchema = z.object({
  input_per_mtok_usd: usd,
  output_per_mtok_usd: usd,
  cached_input_per_mtok_usd: usd.optional(),
  source_url: z.url(),
  effective_from: z.coerce.date(),
});

const modelSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+\/\S+$/, 'must look like <provider>/<model>'),
  upstream_model: z.string().min(1),
  description: z.string().optional(),
  context_window: z.number().int().positive(),
  max_output_tokens: z.number().int().positive(),
  capabilities: z.object({
    tools: z.boolean().default(false),
    vision: z.boolean().default(false),
    json_mode: z.boolean().default(false),
    streaming: z.boolean().default(true),
  }),
  quality_tier: z.number().int().min(1).max(3),
  latency_tier: z.enum(['fast', 'standard', 'slow']),
  enabled: z.boolean().default(true),
  price: priceSchema,
});

const policySchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  requirements: z.record(z.string(), z.unknown()).default({}),
  fallback_chain: z.array(z.string()).max(4).default([]),
  enabled: z.boolean().default(true),
});

export type CatalogModelDefinition = z.infer<typeof modelSchema>;
export type RoutingPolicyDefinition = z.infer<typeof policySchema>;
export type CatalogDefinition = {
  models: CatalogModelDefinition[];
  routingPolicies: RoutingPolicyDefinition[];
};

export class CatalogDefinitionError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid model catalog:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'CatalogDefinitionError';
  }
}

/** Validates the catalog, reporting every problem by model id rather than array index. */
export function parseCatalog(source: string): CatalogDefinition {
  const raw = (parse(source) ?? {}) as { models?: unknown; routing_policies?: unknown };
  const problems: string[] = [];
  const models: CatalogModelDefinition[] = [];
  const policies: RoutingPolicyDefinition[] = [];

  if (!Array.isArray(raw.models) || raw.models.length === 0)
    problems.push('models: at least one model is required');
  for (const [i, entry] of (Array.isArray(raw.models) ? raw.models : []).entries()) {
    const name = (entry as { id?: unknown })?.id;
    const label = typeof name === 'string' ? `model "${name}"` : `models[${i}]`;
    if (entry && typeof entry === 'object' && !('price' in entry)) {
      problems.push(`${label} has no price`);
      continue;
    }
    const parsed = modelSchema.safeParse(entry);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        problems.push(`${label} ${issue.path.join('.')}: ${issue.message}`);
      continue;
    }
    try {
      usdToMicros(parsed.data.price.input_per_mtok_usd);
      usdToMicros(parsed.data.price.output_per_mtok_usd);
      if (parsed.data.price.cached_input_per_mtok_usd !== undefined)
        usdToMicros(parsed.data.price.cached_input_per_mtok_usd);
    } catch (err) {
      problems.push(`${label} price: ${(err as Error).message}`);
      continue;
    }
    models.push(parsed.data);
  }

  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) problems.push(`model "${model.id}" is defined more than once`);
    ids.add(model.id);
  }

  for (const [i, entry] of (Array.isArray(raw.routing_policies)
    ? raw.routing_policies
    : []
  ).entries()) {
    const parsed = policySchema.safeParse(entry);
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        problems.push(`routing_policies[${i}] ${issue.path.join('.')}: ${issue.message}`);
      continue;
    }
    for (const member of parsed.data.fallback_chain) {
      if (!ids.has(member))
        problems.push(`routing policy "${parsed.data.id}" references unknown model "${member}"`);
    }
    if (ids.has(parsed.data.id))
      problems.push(`routing policy "${parsed.data.id}" collides with a model id`);
    policies.push(parsed.data);
  }

  if (problems.length) throw new CatalogDefinitionError(problems);
  return { models, routingPolicies: policies };
}

export function loadCatalogFile(file = defaultCatalogPath): CatalogDefinition {
  return parseCatalog(readFileSync(file, 'utf8'));
}

export const providerOf = (modelId: string) => modelId.slice(0, modelId.indexOf('/'));
