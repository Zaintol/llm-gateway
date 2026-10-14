import type { ChatCompletionRequest, ChatCompletionResponse } from '@gw/schema';
import { z } from 'zod';
import { ProviderError } from './errors.js';
import { postJson, resolveBaseUrl } from './http.js';
import type { ProviderAdapter, ProviderCall, ProviderResult } from './types.js';

const upstreamResponseSchema = z.object({
  id: z.string(),
  created: z.number(),
  choices: z
    .array(
      z.object({
        index: z.number(),
        message: z.object({
          role: z.literal('assistant'),
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                type: z.literal('function'),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .optional(),
        }),
        finish_reason: z.enum(['stop', 'length', 'tool_calls', 'content_filter']).nullable(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().optional() }).nullish(),
    })
    .nullish(),
});

/** Rough fallback when an endpoint omits usage: ~4 characters per token. */
export const estimateTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

export type OpenAiCompatibleOptions = {
  provider: string;
  defaultBaseUrl?: string;
  requiresCredential?: boolean;
  fetch?: typeof fetch;
};

/**
 * Adapter for the OpenAI chat completions API and anything that speaks it (Ollama, vLLM, the
 * mock provider). The base URL comes from the credential row when set, so the same adapter can
 * target proxies or OpenAI-compatible hosts.
 */
export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly provider: string;
  readonly requiresCredential: boolean;
  private readonly defaultBaseUrl: string | undefined;
  private readonly fetch: typeof fetch;

  constructor(options: OpenAiCompatibleOptions) {
    this.provider = options.provider;
    this.requiresCredential = options.requiresCredential ?? true;
    this.defaultBaseUrl = options.defaultBaseUrl;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  /** Canonical request to OpenAI wire format. Gateway-only fields never leave the gateway. */
  buildRequest(request: ChatCompletionRequest, upstreamModel: string): Record<string, unknown> {
    const { gateway, stream, stream_options, ...rest } = request;
    return { ...rest, model: upstreamModel, stream: false };
  }

  parseResponse(body: unknown, request: ChatCompletionRequest): ProviderResult {
    const parsed = upstreamResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProviderError('provider_error', this.provider, 'Malformed response from provider');
    }
    const upstream = parsed.data;
    const choices = upstream.choices.map((choice) => ({
      index: choice.index,
      message: {
        role: 'assistant' as const,
        content: choice.message.content ?? null,
        ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}),
      },
      finish_reason: choice.finish_reason,
      logprobs: null,
    }));

    const usage = upstream.usage
      ? {
          inputTokens: upstream.usage.prompt_tokens,
          outputTokens: upstream.usage.completion_tokens,
          cachedInputTokens: upstream.usage.prompt_tokens_details?.cached_tokens ?? 0,
          source: 'provider' as const,
        }
      : {
          inputTokens: estimateTokens(JSON.stringify(request.messages)),
          outputTokens: estimateTokens(
            choices
              .map((c) => (c.message.content ?? '') + JSON.stringify(c.message.tool_calls ?? ''))
              .join(''),
          ),
          cachedInputTokens: 0,
          source: 'estimated' as const,
        };

    const response: ChatCompletionResponse = {
      id: upstream.id,
      object: 'chat.completion',
      created: upstream.created,
      model: request.model,
      choices,
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
      },
    };
    return { response, usage };
  }

  async complete(request: ChatCompletionRequest, call: ProviderCall): Promise<ProviderResult> {
    const baseUrl = resolveBaseUrl(this.provider, call, this.defaultBaseUrl);
    const body = await postJson({
      provider: this.provider,
      url: `${baseUrl}/chat/completions`,
      headers: call.credential ? { authorization: `Bearer ${call.credential.secret}` } : {},
      body: this.buildRequest(request, call.upstreamModel),
      signal: call.signal,
      fetch: this.fetch,
    });
    return this.parseResponse(body, request);
  }
}
