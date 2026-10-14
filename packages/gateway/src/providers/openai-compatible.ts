import type { ChatCompletionRequest, ChatCompletionResponse } from '@gw/schema';
import { z } from 'zod';
import type { ResolvedCredential } from '../credentials/service.js';
import { ProviderError } from './errors.js';
import { openStream, postJson, resolveBaseUrl, streamReadError } from './http.js';
import { parseSse } from './sse.js';
import type {
  ProviderAdapter,
  ProviderCall,
  ProviderResult,
  ProviderUsage,
  StreamDelta,
  StreamEvent,
} from './types.js';

const streamChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        index: z.number(),
        delta: z
          .object({
            role: z.string().optional(),
            content: z.string().nullish(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number(),
                  id: z.string().optional(),
                  type: z.literal('function').optional(),
                  function: z
                    .object({ name: z.string().optional(), arguments: z.string().optional() })
                    .optional(),
                }),
              )
              .optional(),
          })
          .optional(),
        finish_reason: z.enum(['stop', 'length', 'tool_calls', 'content_filter']).nullish(),
      }),
    )
    .default([]),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().optional() }).nullish(),
    })
    .nullish(),
  error: z.object({ message: z.string() }).loose().optional(),
});

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

  isConfigured(credential: ResolvedCredential | null): boolean {
    return Boolean(credential?.baseUrl ?? this.defaultBaseUrl);
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

  async *stream(request: ChatCompletionRequest, call: ProviderCall): AsyncGenerator<StreamEvent> {
    const baseUrl = resolveBaseUrl(this.provider, call, this.defaultBaseUrl);
    const body = await openStream({
      provider: this.provider,
      url: `${baseUrl}/chat/completions`,
      headers: call.credential ? { authorization: `Bearer ${call.credential.secret}` } : {},
      // Usage is always requested upstream so the gateway can meter; the client opts in separately.
      body: {
        ...this.buildRequest(request, call.upstreamModel),
        stream: true,
        stream_options: { include_usage: true },
      },
      signal: call.signal,
      fetch: this.fetch,
    });

    let usage: ProviderUsage | undefined;
    let output = '';
    try {
      for await (const event of parseSse(body)) {
        if (event.data === '[DONE]') break;
        let json: unknown;
        try {
          json = JSON.parse(event.data);
        } catch {
          throw new ProviderError(
            'provider_error',
            this.provider,
            'Malformed stream chunk from provider',
          );
        }
        const chunk = streamChunkSchema.safeParse(json);
        if (!chunk.success) {
          throw new ProviderError(
            'provider_error',
            this.provider,
            'Malformed stream chunk from provider',
          );
        }
        if (chunk.data.error) {
          throw new ProviderError('provider_error', this.provider, chunk.data.error.message);
        }
        if (chunk.data.usage) {
          usage = {
            inputTokens: chunk.data.usage.prompt_tokens,
            outputTokens: chunk.data.usage.completion_tokens,
            cachedInputTokens: chunk.data.usage.prompt_tokens_details?.cached_tokens ?? 0,
            source: 'provider',
          };
        }
        for (const choice of chunk.data.choices) {
          if (choice.index !== 0) continue;
          const delta: StreamDelta = {};
          if (choice.delta?.role === 'assistant') delta.role = 'assistant';
          if (choice.delta?.content) {
            delta.content = choice.delta.content;
            output += choice.delta.content;
          }
          if (choice.delta?.tool_calls) {
            delta.tool_calls = choice.delta.tool_calls.map((t) => ({
              index: t.index,
              ...(t.id ? { id: t.id } : {}),
              ...(t.type ? { type: t.type } : {}),
              ...(t.function ? { function: stripUndefined(t.function) } : {}),
            }));
            output += JSON.stringify(choice.delta.tool_calls);
          }
          yield { type: 'delta', delta, finishReason: choice.finish_reason ?? null };
        }
      }
    } catch (err) {
      throw streamReadError(this.provider, err, call.signal);
    }
    yield {
      type: 'usage',
      usage: usage ?? {
        inputTokens: estimateTokens(JSON.stringify(request.messages)),
        outputTokens: estimateTokens(output),
        cachedInputTokens: 0,
        source: 'estimated',
      },
    };
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

function stripUndefined<T extends Record<string, unknown>>(
  value: T,
): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}
