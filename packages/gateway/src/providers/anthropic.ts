import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  FinishReason,
  ToolCall,
} from '@gw/schema';
import { z } from 'zod';
import { ProviderError } from './errors.js';
import { openStream, postJson, resolveBaseUrl, streamReadError } from './http.js';
import { estimateTokens } from './openai-compatible.js';
import { parseSse } from './sse.js';
import type { ProviderAdapter, ProviderCall, ProviderResult, StreamEvent } from './types.js';

/** The subset of Anthropic stream events the gateway translates; others (ping) are ignored. */
const streamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message_start'),
    message: z.object({
      usage: z.object({
        input_tokens: z.number(),
        cache_read_input_tokens: z.number().nullish(),
        cache_creation_input_tokens: z.number().nullish(),
      }),
    }),
  }),
  z.object({
    type: z.literal('content_block_start'),
    index: z.number(),
    content_block: z.object({
      type: z.string(),
      id: z.string().optional(),
      name: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal('content_block_delta'),
    index: z.number(),
    delta: z.object({
      type: z.string(),
      text: z.string().optional(),
      partial_json: z.string().optional(),
    }),
  }),
  z.object({ type: z.literal('content_block_stop') }).loose(),
  z.object({
    type: z.literal('message_delta'),
    delta: z.object({ stop_reason: z.string().nullish() }).loose(),
    usage: z.object({ output_tokens: z.number() }).loose().optional(),
  }),
  z.object({ type: z.literal('message_stop') }).loose(),
  z.object({ type: z.literal('ping') }).loose(),
  z.object({
    type: z.literal('error'),
    error: z.object({ type: z.string(), message: z.string() }),
  }),
]);

export const ANTHROPIC_VERSION = '2023-06-01';
/** Used when neither the request nor the catalog sets max_tokens, which Anthropic requires. */
export const DEFAULT_MAX_TOKENS = 4096;

type TextBlock = { type: 'text'; text: string };
type ImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
};
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string };
type Block = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;
type AnthropicMessage = { role: 'user' | 'assistant'; content: Block[] };

const upstreamResponseSchema = z.object({
  id: z.string(),
  content: z.array(
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('text'), text: z.string() }),
      z.object({
        type: z.literal('tool_use'),
        id: z.string(),
        name: z.string(),
        input: z.unknown(),
      }),
      z.object({ type: z.literal('thinking') }).loose(),
      z.object({ type: z.literal('redacted_thinking') }).loose(),
    ]),
  ),
  stop_reason: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_input_tokens: z.number().nullish(),
    cache_creation_input_tokens: z.number().nullish(),
  }),
});

const finishReasons: Record<string, FinishReason> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  pause_turn: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};

const JSON_MODE_INSTRUCTION =
  'Respond with a single valid JSON object only. Do not wrap it in markdown or add any other text.';

const textOf = (content: string | Array<{ text: string }>) =>
  typeof content === 'string' ? content : content.map((p) => p.text).join('\n');

/** Translates between the canonical (OpenAI) format and the Anthropic Messages API. */
export class AnthropicAdapter implements ProviderAdapter {
  readonly provider = 'anthropic';
  readonly requiresCredential = true;
  private readonly fetch: typeof fetch;
  private readonly defaultBaseUrl: string;

  constructor(options: { defaultBaseUrl?: string; fetch?: typeof fetch } = {}) {
    this.defaultBaseUrl = options.defaultBaseUrl ?? 'https://api.anthropic.com';
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  private reject(message: string): never {
    throw new ProviderError('invalid_request', this.provider, message);
  }

  private imageBlock(url: string): ImageBlock {
    const dataUrl = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(url);
    if (dataUrl) {
      return {
        type: 'image',
        source: { type: 'base64', media_type: dataUrl[1]!, data: dataUrl[2]! },
      };
    }
    if (/^https?:\/\//i.test(url)) return { type: 'image', source: { type: 'url', url } };
    return this.reject('image_url must be an http(s) URL or a base64 data URL');
  }

  private toBlocks(
    message: Exclude<ChatMessage, { role: 'system' | 'developer' }>,
  ): AnthropicMessage {
    switch (message.role) {
      case 'user':
        return {
          role: 'user',
          content:
            typeof message.content === 'string'
              ? [{ type: 'text', text: message.content }]
              : message.content.map((part) =>
                  part.type === 'text'
                    ? { type: 'text' as const, text: part.text }
                    : this.imageBlock(part.image_url.url),
                ),
        };
      case 'assistant': {
        const blocks: Block[] = [];
        const text = message.content ? textOf(message.content) : '';
        if (text) blocks.push({ type: 'text', text });
        for (const call of message.tool_calls ?? []) {
          let input: unknown;
          try {
            input = JSON.parse(call.function.arguments || '{}');
          } catch {
            this.reject(`tool_calls[${call.id}].function.arguments is not valid JSON`);
          }
          blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
        }
        return { role: 'assistant', content: blocks };
      }
      case 'tool':
        // Anthropic carries tool results inside a user turn.
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.tool_call_id,
              content: textOf(message.content),
            },
          ],
        };
    }
  }

  buildRequest(
    request: ChatCompletionRequest,
    call: Pick<ProviderCall, 'upstreamModel' | 'maxOutputTokens'>,
  ) {
    const emulated: string[] = [];
    const system = request.messages
      .filter((m) => m.role === 'system' || m.role === 'developer')
      .map((m) => textOf(m.content));

    if (request.response_format?.type === 'json_object') {
      system.push(JSON_MODE_INSTRUCTION);
      emulated.push('json_mode');
    } else if (request.response_format?.type === 'json_schema') {
      const { schema } = request.response_format.json_schema;
      system.push(
        `${JSON_MODE_INSTRUCTION}${schema ? ` It must match this JSON Schema: ${JSON.stringify(schema)}` : ''}`,
      );
      emulated.push('json_schema');
    }

    // Anthropic requires alternating roles, so consecutive same-role turns are merged.
    const messages: AnthropicMessage[] = [];
    for (const message of request.messages) {
      if (message.role === 'system' || message.role === 'developer') continue;
      const converted = this.toBlocks(message);
      const previous = messages.at(-1);
      if (previous?.role === converted.role) previous.content.push(...converted.content);
      else messages.push(converted);
    }
    if (messages.length === 0) this.reject('At least one user message is required');
    if (messages[0]!.role !== 'user') {
      this.reject(
        'Anthropic models require the conversation to start with a user message (after any system messages); this one starts with an assistant message',
      );
    }

    const body: Record<string, unknown> = {
      model: call.upstreamModel,
      max_tokens: request.max_tokens ?? call.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      messages,
    };
    if (system.length) body.system = system.join('\n\n');
    // Anthropic accepts temperature 0-1; OpenAI allows up to 2.
    if (request.temperature !== undefined) body.temperature = Math.min(request.temperature, 1);
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.stop !== undefined)
      body.stop_sequences = typeof request.stop === 'string' ? [request.stop] : request.stop;
    if (request.user) body.metadata = { user_id: request.user };
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        name: t.function.name,
        ...(t.function.description ? { description: t.function.description } : {}),
        input_schema: t.function.parameters ?? { type: 'object', properties: {} },
      }));
    }
    if (request.tool_choice !== undefined) {
      const choice = request.tool_choice;
      body.tool_choice =
        choice === 'auto'
          ? { type: 'auto' }
          : choice === 'required'
            ? { type: 'any' }
            : choice === 'none'
              ? { type: 'none' }
              : { type: 'tool', name: choice.function.name };
    }
    return { body, emulated };
  }

  parseResponse(body: unknown, request: ChatCompletionRequest): ProviderResult {
    const parsed = upstreamResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProviderError('provider_error', this.provider, 'Malformed response from provider');
    }
    const upstream = parsed.data;
    const text = upstream.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const toolCalls: ToolCall[] = upstream.content
      .filter(
        (b): b is { type: 'tool_use'; id: string; name: string; input: unknown } =>
          b.type === 'tool_use',
      )
      .map((b) => ({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));

    const cacheRead = upstream.usage.cache_read_input_tokens ?? 0;
    const cacheWrite = upstream.usage.cache_creation_input_tokens ?? 0;
    // Anthropic's input_tokens excludes cached tokens; OpenAI's prompt_tokens includes them.
    const inputTokens = upstream.usage.input_tokens + cacheRead + cacheWrite;
    const outputTokens = upstream.usage.output_tokens;

    const response: ChatCompletionResponse = {
      id: upstream.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: text || (toolCalls.length ? null : ''),
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finishReasons[upstream.stop_reason ?? ''] ?? 'stop',
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    };
    return {
      response,
      usage: { inputTokens, outputTokens, cachedInputTokens: cacheRead, source: 'provider' },
    };
  }

  async *stream(request: ChatCompletionRequest, call: ProviderCall): AsyncGenerator<StreamEvent> {
    const { body } = this.buildRequest(request, call);
    const events = await openStream({
      provider: this.provider,
      url: `${resolveBaseUrl(this.provider, call, this.defaultBaseUrl)}/v1/messages`,
      headers: {
        'x-api-key': call.credential?.secret ?? '',
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: { ...body, stream: true },
      signal: call.signal,
      fetch: this.fetch,
    });

    let inputTokens = 0;
    let cachedInputTokens = 0;
    let outputTokens: number | undefined;
    let output = '';
    // Anthropic numbers all content blocks; OpenAI numbers only tool calls.
    const toolIndexByBlock = new Map<number, number>();
    try {
      for await (const raw of parseSse(events)) {
        let json: unknown;
        try {
          json = JSON.parse(raw.data);
        } catch {
          throw new ProviderError(
            'provider_error',
            this.provider,
            'Malformed stream event from provider',
          );
        }
        const parsed = streamEventSchema.safeParse(json);
        if (!parsed.success) continue; // unknown event types are forward-compatible no-ops
        const event = parsed.data;
        switch (event.type) {
          case 'message_start': {
            const u = event.message.usage;
            cachedInputTokens = u.cache_read_input_tokens ?? 0;
            inputTokens = u.input_tokens + cachedInputTokens + (u.cache_creation_input_tokens ?? 0);
            yield { type: 'delta', delta: { role: 'assistant' }, finishReason: null };
            break;
          }
          case 'content_block_start':
            if (event.content_block.type === 'tool_use') {
              const index = toolIndexByBlock.size;
              toolIndexByBlock.set(event.index, index);
              yield {
                type: 'delta',
                delta: {
                  tool_calls: [
                    {
                      index,
                      id: event.content_block.id ?? `call_${index}`,
                      type: 'function',
                      function: { name: event.content_block.name ?? '', arguments: '' },
                    },
                  ],
                },
                finishReason: null,
              };
            }
            break;
          case 'content_block_delta':
            if (event.delta.type === 'text_delta' && event.delta.text) {
              output += event.delta.text;
              yield { type: 'delta', delta: { content: event.delta.text }, finishReason: null };
            } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
              const index = toolIndexByBlock.get(event.index);
              if (index === undefined) break;
              output += event.delta.partial_json;
              yield {
                type: 'delta',
                delta: {
                  tool_calls: [{ index, function: { arguments: event.delta.partial_json } }],
                },
                finishReason: null,
              };
            }
            break;
          case 'message_delta':
            if (event.usage) outputTokens = event.usage.output_tokens;
            if (event.delta.stop_reason) {
              yield {
                type: 'delta',
                delta: {},
                finishReason: finishReasons[event.delta.stop_reason] ?? 'stop',
              };
            }
            break;
          case 'error':
            throw new ProviderError('provider_error', this.provider, event.error.message);
          default:
            break;
        }
      }
    } catch (err) {
      throw streamReadError(this.provider, err, call.signal);
    }
    yield {
      type: 'usage',
      usage: {
        inputTokens: inputTokens || estimateTokens(JSON.stringify(request.messages)),
        outputTokens: outputTokens ?? estimateTokens(output),
        cachedInputTokens,
        source: outputTokens === undefined || inputTokens === 0 ? 'estimated' : 'provider',
      },
    };
  }

  async complete(request: ChatCompletionRequest, call: ProviderCall): Promise<ProviderResult> {
    const { body, emulated } = this.buildRequest(request, call);
    const upstream = await postJson({
      provider: this.provider,
      url: `${resolveBaseUrl(this.provider, call, this.defaultBaseUrl)}/v1/messages`,
      headers: {
        'x-api-key': call.credential?.secret ?? '',
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body,
      signal: call.signal,
      fetch: this.fetch,
    });
    const result = this.parseResponse(upstream, request);
    return emulated.length ? { ...result, emulated } : result;
  }
}
