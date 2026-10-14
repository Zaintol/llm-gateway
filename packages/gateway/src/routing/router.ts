import type { ChatCompletionRequest } from '@gw/schema';
import { formatUsd, worstCaseCostMicros } from '../budget/service.js';
import {
  priceAt,
  type CatalogModel,
  type ModelCatalog,
  type RoutingPolicy,
} from '../catalog/catalog.js';
import type { CredentialSource } from '../chat/route.js';
import { GatewayError } from '../errors.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { requirementsOf, unmetRequirements } from './requirements.js';
import { estimatePromptTokens } from './tokens.js';

/** Routed chains keep the cheapest few: enough to survive an outage, cheap to explain. */
export const ROUTED_CHAIN_LENGTH = 3;
/** Output tokens assumed when ranking by expected cost and the request sets no max_tokens. */
const EXPECTED_OUTPUT_TOKENS = 1024n;
const LATENCY_RANK = { fast: 0, standard: 1, slow: 2 } as const;

export type RouteDecision = { chain: string[]; reason: string };

type Ranked = { model: CatalogModel; expectedMicros: bigint };

/**
 * Picks the cheapest models that can serve a request to a virtual model. Requirements come from
 * the request (capabilities, context length), the policy's requirement set, and explicit
 * `gateway` fields, which override the policy. Ties go to the faster, then higher-quality model;
 * observed p95 latency replaces the static tier once latency metrics exist (GW-8.2).
 */
export async function routeByCost(input: {
  request: ChatCompletionRequest;
  policy: RoutingPolicy;
  catalog: ModelCatalog;
  registry: ProviderRegistry;
  credentials: CredentialSource;
  tenantId: string;
  at: Date;
}): Promise<RouteDecision> {
  const { request, policy } = input;
  const minQuality =
    request.gateway?.min_quality_tier ?? numberOf(policy.requirements.min_quality_tier);
  const latencyCap = request.gateway?.latency_tier ?? latencyOf(policy.requirements.latency_tier);
  const maxCostMicros =
    request.gateway?.max_cost_usd === undefined
      ? undefined
      : BigInt(Math.floor(request.gateway.max_cost_usd * 1_000_000));
  const requirements = requirementsOf(request);
  const providers = new Set(input.registry.providers);

  const ranked: Ranked[] = [];
  const excluded: string[] = [];
  for (const model of input.catalog.listModels()) {
    if (!model.enabled || !model.routable || !providers.has(model.provider)) continue;
    const reasons = unmetRequirements(model, requirements);
    if (minQuality !== undefined && model.qualityTier < minQuality)
      reasons.push(`quality tier ${model.qualityTier} < ${minQuality}`);
    if (latencyCap && LATENCY_RANK[model.latencyTier] > LATENCY_RANK[latencyCap])
      reasons.push(`${model.latencyTier} latency`);
    const price = priceAt(model, input.at);
    if (!price) reasons.push('no current price');
    if (price && maxCostMicros !== undefined) {
      const worst = worstCaseCostMicros(request, { model, provider: model.provider }, input.at);
      if (worst > maxCostMicros) reasons.push(`worst case ${formatUsd(worst)} > max_cost_usd`);
    }
    if (reasons.length === 0) {
      const credential = await input.credentials.resolve(input.tenantId, model.provider);
      if (input.registry.requiresCredential(model.provider) && !credential) {
        reasons.push(`no ${model.provider} credential`);
      } else if (!input.registry.isConfigured(model.provider, credential)) {
        reasons.push(`no ${model.provider} endpoint configured`);
      }
    }
    if (reasons.length) {
      excluded.push(`${model.id} (${reasons.join(', ')})`);
      continue;
    }
    const prompt = BigInt(estimatePromptTokens(request, model.provider));
    const output =
      request.max_tokens === undefined ? EXPECTED_OUTPUT_TOKENS : BigInt(request.max_tokens);
    ranked.push({
      model,
      expectedMicros: prompt * price!.inputPerMtokMicros + output * price!.outputPerMtokMicros,
    });
  }

  if (ranked.length === 0) {
    throw new GatewayError(
      400,
      'no_eligible_model',
      'no_eligible_model',
      `No model meets the requirements of "${request.model}": ${excluded.slice(0, 8).join('; ') || 'no models are configured'}`,
    );
  }
  ranked.sort(
    (a, b) =>
      (a.expectedMicros < b.expectedMicros ? -1 : a.expectedMicros > b.expectedMicros ? 1 : 0) ||
      LATENCY_RANK[a.model.latencyTier] - LATENCY_RANK[b.model.latencyTier] ||
      b.model.qualityTier - a.model.qualityTier ||
      a.model.id.localeCompare(b.model.id),
  );
  const chain = ranked.slice(0, ROUTED_CHAIN_LENGTH).map((r) => r.model.id);
  const [cheapest, ...fallbacks] = chain;
  const reason =
    `cost-aware: ${cheapest} is the cheapest of ${ranked.length} eligible` +
    (fallbacks.length ? `; fallbacks ${fallbacks.join(', ')}` : '') +
    (excluded.length ? `; ${excluded.length} excluded` : '');
  return { chain, reason };
}

const numberOf = (value: unknown) => (typeof value === 'number' ? value : undefined);
const latencyOf = (value: unknown) =>
  value === 'fast' || value === 'standard' || value === 'slow' ? value : undefined;
