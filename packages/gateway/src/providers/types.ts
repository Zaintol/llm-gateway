import type { ChatCompletionRequest, ChatCompletionResponse } from '@gw/schema';
import type { ResolvedCredential } from '../credentials/service.js';

export type ProviderUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** `estimated` when the provider did not report usage and the gateway counted locally. */
  source: 'provider' | 'estimated';
};

export type ProviderCall = {
  /** Model name as the provider knows it, e.g. `gpt-4o-mini`. */
  upstreamModel: string;
  credential: ResolvedCredential | null;
  signal: AbortSignal;
};

export type ProviderResult = {
  response: ChatCompletionResponse;
  usage: ProviderUsage;
};

/**
 * One implementation per provider family. Adapters translate the canonical request to the
 * provider's wire format and back, and map every failure to a ProviderError so the execution
 * engine can decide on retries and fallback without knowing provider details.
 */
export interface ProviderAdapter {
  readonly provider: string;
  /** False for endpoints that need no API key (local models, the mock provider). */
  readonly requiresCredential: boolean;
  complete(request: ChatCompletionRequest, call: ProviderCall): Promise<ProviderResult>;
}
