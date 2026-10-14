import type { ChatCompletionRequest } from '@gw/schema';
import type { ModelCatalog } from '../catalog/catalog.js';
import type { CredentialSource } from '../chat/route.js';
import type { ResolvedCredential } from '../credentials/service.js';
import { GatewayError } from '../errors.js';
import type { ProviderRegistry, ResolvedModel } from '../providers/registry.js';
import { requirementsOf, unmetRequirements } from './requirements.js';

export const MAX_CHAIN_LENGTH = 4;

export type Candidate = ResolvedModel & { credential: ResolvedCredential | null };
export type SkippedCandidate = { id: string; reason: string };
export type Plan = { candidates: Candidate[]; skipped: SkippedCandidate[]; virtual: boolean };

/**
 * Turns the requested model into an ordered candidate chain.
 * - Virtual model (routing policy): its fallback chain.
 * - Concrete model: just that model, plus the tenant's default chain when gateway.fallback is set.
 * Candidates that cannot serve the request (missing capability, unknown or disabled model,
 * provider not configured, no credential) are skipped with a reason.
 */
export async function planCandidates(input: {
  request: ChatCompletionRequest;
  registry: ProviderRegistry;
  catalog?: ModelCatalog;
  credentials: CredentialSource;
  tenantId: string;
  tenantSettings: Record<string, unknown>;
}): Promise<Plan> {
  const { request, registry, catalog } = input;
  const policy = catalog?.getPolicy(request.model);
  let chain: string[];
  let virtual = false;

  if (policy) {
    if (!policy.enabled) {
      throw new GatewayError(
        400,
        'no_eligible_model',
        'model_disabled',
        `Model "${request.model}" is disabled`,
      );
    }
    chain = policy.fallbackChain;
    virtual = true;
  } else {
    registry.resolve(request.model); // unknown or disabled concrete models fail fast with 400
    chain = [request.model];
    if (request.gateway?.fallback) chain.push(...defaultChain(input.tenantSettings, catalog));
  }
  chain = [...new Set(chain)].slice(0, MAX_CHAIN_LENGTH);

  const requirements = requirementsOf(request);
  const candidates: Candidate[] = [];
  const skipped: SkippedCandidate[] = [];
  for (const id of chain) {
    let resolved: ResolvedModel;
    try {
      resolved = registry.resolve(id);
    } catch (err) {
      skipped.push({ id, reason: err instanceof GatewayError ? err.code : 'unavailable' });
      continue;
    }
    const unmet = resolved.model ? unmetRequirements(resolved.model, requirements) : [];
    if (unmet.length) {
      skipped.push({ id, reason: `lacks ${unmet.join(', ')}` });
      continue;
    }
    const credential = await input.credentials.resolve(input.tenantId, resolved.provider);
    if (resolved.adapter.requiresCredential && !credential) {
      skipped.push({ id, reason: `no ${resolved.provider} credential` });
      continue;
    }
    candidates.push({ ...resolved, credential });
  }

  if (candidates.length === 0) {
    const detail = skipped.map((s) => `${s.id} (${s.reason})`).join('; ');
    throw new GatewayError(
      400,
      'no_eligible_model',
      chain.length === 1 && skipped[0]?.reason.startsWith('no ')
        ? 'provider_not_configured'
        : 'no_eligible_model',
      `No model can serve this request: ${detail}`,
    );
  }
  return { candidates, skipped, virtual };
}

/** The tenant's `fallback_chain` setting, else the `auto` policy chain. */
function defaultChain(settings: Record<string, unknown>, catalog?: ModelCatalog): string[] {
  const configured = settings.fallback_chain;
  if (Array.isArray(configured) && configured.every((m) => typeof m === 'string'))
    return configured;
  return catalog?.getPolicy('auto')?.fallbackChain ?? [];
}
