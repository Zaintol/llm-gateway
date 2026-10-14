import type { ChatCompletionRequest } from '@gw/schema';
import { describe, expect, it } from 'vitest';
import { AnthropicAdapter, DEFAULT_MAX_TOKENS } from '../../src/providers/anthropic.js';
import { ProviderError } from '../../src/providers/errors.js';
import type { ProviderCall } from '../../src/providers/types.js';

const adapter = new AnthropicAdapter();
const call = { upstreamModel: 'claude-sonnet-x' };
const build = (request: Partial<ChatCompletionRequest>, extra: Partial<ProviderCall> = {}) =>
  adapter.buildRequest(
    { model: 'anthropic/claude-sonnet-x', messages: [{ role: 'user', content: 'hi' }], ...request },
    { ...call, ...extra },
  );

function rejection(fn: () => unknown): ProviderError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ProviderError) return err;
    throw err;
  }
  throw new Error('expected a ProviderError');
}

describe('AnthropicAdapter request translation', () => {
  it('moves system messages to the top-level system field and merges consecutive user turns', () => {
    const { body } = build({
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'developer', content: 'Answer in English.' },
        { role: 'user', content: 'First question' },
        { role: 'user', content: 'Second question' },
      ],
    });
    expect(body.system).toBe('You are terse.\n\nAnswer in English.');
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'First question' },
          { type: 'text', text: 'Second question' },
        ],
      },
    ]);
  });

  it('uses the catalog max output tokens when the request has no max_tokens', () => {
    expect(build({}, { maxOutputTokens: 8192 }).body.max_tokens).toBe(8192);
    expect(build({}).body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(build({ max_tokens: 50 }, { maxOutputTokens: 8192 }).body.max_tokens).toBe(50);
  });

  it('rejects a conversation that starts with an assistant message, explaining why', () => {
    const err = rejection(() =>
      build({
        messages: [
          { role: 'system', content: 's' },
          { role: 'assistant', content: 'Hello!' },
          { role: 'user', content: 'hi' },
        ],
      }),
    );
    expect(err.kind).toBe('invalid_request');
    expect(err.message).toMatch(/start with a user message/);
  });

  it('maps tools, tool calls and tool results', () => {
    const { body } = build({
      tools: [
        {
          type: 'function',
          function: { name: 'lookup', description: 'Find', parameters: { type: 'object' } },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'lookup' } },
      messages: [
        { role: 'user', content: 'Find cats' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'lookup', arguments: '{"q":"cats"}' },
            },
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'lookup', arguments: '{"q":"dogs"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '3 cats' },
        { role: 'tool', tool_call_id: 'call_2', content: '2 dogs' },
      ],
    });
    expect(body.tools).toEqual([
      { name: 'lookup', description: 'Find', input_schema: { type: 'object' } },
    ]);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'lookup' });
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Find cats' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'cats' } },
          { type: 'tool_use', id: 'call_2', name: 'lookup', input: { q: 'dogs' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: '3 cats' },
          { type: 'tool_result', tool_use_id: 'call_2', content: '2 dogs' },
        ],
      },
    ]);
  });

  it.each([
    ['auto', { type: 'auto' }],
    ['required', { type: 'any' }],
    ['none', { type: 'none' }],
  ] as const)('maps tool_choice %s', (choice, expected) => {
    expect(build({ tool_choice: choice }).body.tool_choice).toEqual(expected);
  });

  it('rejects tool call arguments that are not JSON', () => {
    const err = rejection(() =>
      build({
        messages: [
          { role: 'user', content: 'x' },
          {
            role: 'assistant',
            tool_calls: [
              { id: 'c', type: 'function', function: { name: 'f', arguments: '{oops' } },
            ],
          },
        ],
      }),
    );
    expect(err.kind).toBe('invalid_request');
  });

  it('maps image parts to base64 or url image blocks', () => {
    const { body } = build({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } },
          ],
        },
      ],
    });
    expect((body.messages as Array<{ content: unknown[] }>)[0]!.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/cat.jpg' } },
    ]);
    expect(
      rejection(() =>
        build({
          messages: [
            { role: 'user', content: [{ type: 'image_url', image_url: { url: 'ftp://x' } }] },
          ],
        }),
      ).kind,
    ).toBe('invalid_request');
  });

  it('emulates json_object with a system instruction and reports it', () => {
    const { body, emulated } = build({ response_format: { type: 'json_object' } });
    expect(body.system).toMatch(/single valid JSON object/);
    expect(emulated).toEqual(['json_mode']);
  });

  it('clamps temperature to 1 and maps stop and user', () => {
    const { body } = build({ temperature: 1.6, stop: 'END', user: 'u-1' });
    expect(body).toMatchObject({
      temperature: 1,
      stop_sequences: ['END'],
      metadata: { user_id: 'u-1' },
    });
  });
});

describe('AnthropicAdapter response translation', () => {
  const request: ChatCompletionRequest = {
    model: 'anthropic/claude-sonnet-x',
    messages: [{ role: 'user', content: 'hi' }],
  };

  it('returns OpenAI chat completion shape with total input tokens including cache', () => {
    const { response, usage } = adapter.parseResponse(
      {
        id: 'msg_1',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: ' there' },
        ],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 90,
          cache_creation_input_tokens: 0,
        },
      },
      request,
    );
    expect(response).toMatchObject({
      object: 'chat.completion',
      model: 'anthropic/claude-sonnet-x',
      choices: [{ message: { role: 'assistant', content: 'Hello there' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
    });
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 5,
      cachedInputTokens: 90,
      source: 'provider',
    });
  });

  it('returns tool_use blocks as tool_calls with JSON arguments and finish_reason tool_calls', () => {
    const { response } = adapter.parseResponse(
      {
        id: 'msg_2',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'cats' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      request,
    );
    expect(response.choices[0]).toMatchObject({
      message: {
        content: null,
        tool_calls: [
          {
            id: 'toolu_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"q":"cats"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    });
  });

  it.each([
    ['max_tokens', 'length'],
    ['stop_sequence', 'stop'],
    ['refusal', 'content_filter'],
  ])('maps stop_reason %s to finish_reason %s', (stopReason, finish) => {
    const { response } = adapter.parseResponse(
      {
        id: 'm',
        content: [{ type: 'text', text: '' }],
        stop_reason: stopReason,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
      request,
    );
    expect(response.choices[0]!.finish_reason).toBe(finish);
  });
});

describe('AnthropicAdapter HTTP', () => {
  it('sends x-api-key and anthropic-version to /v1/messages', async () => {
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    const http = new AnthropicAdapter({
      defaultBaseUrl: 'https://anthropic.example/',
      fetch: async (url, init) => {
        sent.push({ url: String(url), headers: init!.headers as Record<string, string> });
        return Response.json({
          id: 'msg',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      },
    });
    await http.complete(
      { model: 'anthropic/x', messages: [{ role: 'user', content: 'hi' }] },
      {
        upstreamModel: 'x',
        credential: { secret: 'sk-ant', baseUrl: null, scope: 'tenant' },
        signal: new AbortController().signal,
      },
    );
    expect(sent[0]!.url).toBe('https://anthropic.example/v1/messages');
    expect(sent[0]!.headers).toMatchObject({
      'x-api-key': 'sk-ant',
      'anthropic-version': '2023-06-01',
    });
  });

  it('maps 529 overloaded to a retryable provider_error', async () => {
    const http = new AnthropicAdapter({
      fetch: async () =>
        Response.json(
          { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
          { status: 529 },
        ),
    });
    const err = await http
      .complete(
        { model: 'anthropic/x', messages: [{ role: 'user', content: 'hi' }] },
        { upstreamModel: 'x', credential: null, signal: new AbortController().signal },
      )
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'provider_error', retryable: true, message: 'Overloaded' });
  });
});
