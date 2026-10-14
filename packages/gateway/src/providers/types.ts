import type { ChatCompletionRequest, ChatCompletionResponse, FinishReason } from '@gw/schema';
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
  /** Catalog output limit, used where a provider requires max_tokens (GW-6.1 fills this in). */
  maxOutputTokens?: number;
};

export type ProviderResult = {
  response: ChatCompletionResponse;
  usage: ProviderUsage;
  /** Features the gateway simulated because the provider lacks them natively, e.g. `json_mode`. */
  emulated?: string[];
};

/** Incremental assistant output, in OpenAI `chat.completion.chunk` delta shape. */
export type StreamDelta = {
  role?: 'assistant';
  content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }>;
};

/**
 * What an adapter's stream yields: content deltas as they arrive, then one final usage event.
 * Errors are thrown as ProviderError from the iterator.
 */
export type StreamEvent =
  | { type: 'delta'; delta: StreamDelta; finishReason: FinishReason | null }
  | { type: 'usage'; usage: ProviderUsage };

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
  /** Streams the completion. The upstream request starts on the first `next()`. */
  stream(request: ChatCompletionRequest, call: ProviderCall): AsyncIterable<StreamEvent>;
}
