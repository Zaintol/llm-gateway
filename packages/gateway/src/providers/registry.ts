import { GatewayError } from '../errors.js';
import type { ProviderAdapter } from './types.js';

export type ResolvedModel = {
  id: string;
  provider: string;
  upstreamModel: string;
  adapter: ProviderAdapter;
};

/**
 * Resolves `provider/model` ids to an adapter. Until the model catalog (GW-6.1) exists, any
 * model name is accepted for a registered provider and passed through upstream unchanged.
 */
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(adapters: ProviderAdapter[] = []) {
    for (const adapter of adapters) this.adapters.set(adapter.provider, adapter);
  }

  get providers(): string[] {
    return [...this.adapters.keys()];
  }

  resolve(modelId: string): ResolvedModel {
    const slash = modelId.indexOf('/');
    const provider = slash > 0 ? modelId.slice(0, slash) : '';
    const upstreamModel = slash > 0 ? modelId.slice(slash + 1) : '';
    const adapter = this.adapters.get(provider);
    if (!adapter || !upstreamModel) {
      throw new GatewayError(
        400,
        'no_eligible_model',
        'model_not_found',
        `Model "${modelId}" is not available. Use <provider>/<model>; providers: ${this.providers.join(', ') || 'none'}`,
      );
    }
    return { id: modelId, provider, upstreamModel, adapter };
  }
}
