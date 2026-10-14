import type { ChatCompletionRequest, ChatCompletionResponse } from '@gw/schema';
import { z } from 'zod';
import { ProviderError, errorKindForStatus } from './errors.js';
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

  async mapError(res: Response): Promise<ProviderError> {
    let message = `${this.provider} returned HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: unknown } };
      if (typeof body.error?.message === 'string') message = body.error.message;
    } catch {
      // Non-JSON error body: keep the generic message.
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    return new ProviderError(
      errorKindForStatus(res.status),
      this.provider,
      message,
      res.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }

  async complete(request: ChatCompletionRequest, call: ProviderCall): Promise<ProviderResult> {
    const baseUrl = (call.credential?.baseUrl ?? this.defaultBaseUrl)?.replace(/\/+$/, '');
    if (!baseUrl) {
      throw new ProviderError(
        'provider_error',
        this.provider,
        `No base URL configured for ${this.provider}`,
      );
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (call.credential) headers.authorization = `Bearer ${call.credential.secret}`;

    let res: Response;
    try {
      res = await this.fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(this.buildRequest(request, call.upstreamModel)),
        signal: call.signal,
      });
    } catch (err) {
      if (call.signal.aborted) {
        throw new ProviderError(
          'provider_timeout',
          this.provider,
          `${this.provider} did not respond in time`,
        );
      }
      throw new ProviderError(
        'provider_error',
        this.provider,
        `Could not reach ${this.provider}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) throw await this.mapError(res);

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      if (call.signal.aborted) {
        throw new ProviderError(
          'provider_timeout',
          this.provider,
          `${this.provider} did not respond in time`,
        );
      }
      throw new ProviderError('provider_error', this.provider, 'Provider returned invalid JSON');
    }
    return this.parseResponse(body, request);
  }
}
