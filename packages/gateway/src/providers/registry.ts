import type { CatalogModel, ModelCatalog } from '../catalog/catalog.js';
import { GatewayError } from '../errors.js';
import type { ProviderAdapter } from './types.js';

export type ResolvedModel = {
  id: string;
  provider: string;
  upstreamModel: string;
  adapter: ProviderAdapter;
  /** Catalog entry; absent only when the registry runs without a catalog (tests). */
  model?: CatalogModel;
};

const noEligibleModel = (code: string, message: string) =>
  new GatewayError(400, 'no_eligible_model', code, message);

/**
 * Resolves `provider/model` ids to an adapter and catalog entry. With a catalog, only enabled
 * catalog models are served; without one, any `provider/model` is passed through upstream.
 */
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(
    adapters: ProviderAdapter[] = [],
    private readonly catalog?: ModelCatalog,
  ) {
    for (const adapter of adapters) this.adapters.set(adapter.provider, adapter);
  }

  get providers(): string[] {
    return [...this.adapters.keys()];
  }

  resolve(modelId: string): ResolvedModel {
    if (this.catalog) return this.resolveFromCatalog(this.catalog, modelId);

    const slash = modelId.indexOf('/');
    const provider = slash > 0 ? modelId.slice(0, slash) : '';
    const upstreamModel = slash > 0 ? modelId.slice(slash + 1) : '';
    const adapter = this.adapters.get(provider);
    if (!adapter || !upstreamModel) {
      throw noEligibleModel(
        'model_not_found',
        `Model "${modelId}" is not available. Use <provider>/<model>; providers: ${this.providers.join(', ') || 'none'}`,
      );
    }
    return { id: modelId, provider, upstreamModel, adapter };
  }

  private resolveFromCatalog(catalog: ModelCatalog, modelId: string): ResolvedModel {
    if (!catalog.ready) {
      throw new GatewayError(
        503,
        'internal',
        'catalog_unavailable',
        'Model catalog is not loaded yet',
      );
    }
    const model = catalog.getModel(modelId);
    if (!model) {
      throw noEligibleModel(
        'model_not_found',
        `Model "${modelId}" is not in the catalog. GET /v1/models lists available models`,
      );
    }
    if (!model.enabled) throw noEligibleModel('model_disabled', `Model "${modelId}" is disabled`);
    const adapter = this.adapters.get(model.provider);
    if (!adapter) {
      throw noEligibleModel(
        'provider_not_available',
        `Provider "${model.provider}" is not configured on this gateway`,
      );
    }
    return {
      id: model.id,
      provider: model.provider,
      upstreamModel: model.upstreamModel,
      adapter,
      model,
    };
  }
}
