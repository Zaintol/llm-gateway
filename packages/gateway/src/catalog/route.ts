import type { FastifyPluginAsync } from 'fastify';
import { GatewayError } from '../errors.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { microsToUsd, type ModelCatalog } from './catalog.js';

/**
 * GET /v1/models in OpenAI list shape. Only enabled models whose provider is registered on this
 * gateway are listed; gateway metadata lives under the `gateway` extension key.
 */
export function modelsRoutes(deps: {
  catalog: ModelCatalog;
  providers: ProviderRegistry;
}): FastifyPluginAsync {
  return async (scope) => {
    scope.get('/models', async () => {
      if (!deps.catalog.ready) {
        throw new GatewayError(
          503,
          'internal',
          'catalog_unavailable',
          'Model catalog is not loaded yet',
        );
      }
      const available = new Set(deps.providers.providers);
      return {
        object: 'list',
        data: deps.catalog
          .listModels()
          .filter((m) => m.enabled && available.has(m.provider))
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((m) => ({
            id: m.id,
            object: 'model',
            created: Math.floor(m.createdAt.getTime() / 1000),
            owned_by: m.provider,
            gateway: {
              context_window: m.contextWindow,
              max_output_tokens: m.maxOutputTokens,
              capabilities: {
                tools: m.capabilities.tools,
                vision: m.capabilities.vision,
                json_mode: m.capabilities.jsonMode,
                streaming: m.capabilities.streaming,
              },
              quality_tier: m.qualityTier,
              latency_tier: m.latencyTier,
              pricing: m.price && {
                currency: 'USD',
                input_per_mtok: microsToUsd(m.price.inputPerMtokMicros),
                output_per_mtok: microsToUsd(m.price.outputPerMtokMicros),
                cached_input_per_mtok: microsToUsd(m.price.cachedInputPerMtokMicros),
              },
            },
          })),
      };
    });
  };
}
