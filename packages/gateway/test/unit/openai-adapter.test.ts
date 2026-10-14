import type { ChatCompletionRequest } from '@gw/schema';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/providers/errors.js';
import { OpenAiCompatibleAdapter } from '../../src/providers/openai-compatible.js';
import type { ProviderCall } from '../../src/providers/types.js';

const request: ChatCompletionRequest = {
  model: 'openai/gpt-4o-mini',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 10,
  gateway: { min_quality_tier: 2 },
};
const call = (signal = new AbortController().signal): ProviderCall => ({
  upstreamModel: 'gpt-4o-mini',
  credential: { secret: 'sk-test', baseUrl: null, scope: 'tenant' },
  signal,
});

function adapterReturning(status: number, body: unknown, headers: Record<string, string> = {}) {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const adapter = new OpenAiCompatibleAdapter({
    provider: 'openai',
    defaultBaseUrl: 'https://api.example.com/v1/',
    fetch: async (url, init) => {
      sent.push({ url: String(url), init: init! });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers,
      });
    },
  });
  return { adapter, sent };
}

const upstreamOk = {
  id: 'chatcmpl-abc',
  object: 'chat.completion',
  created: 1700000000,
  model: 'gpt-4o-mini-2024-07-18',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 3,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 4 },
  },
};

async function providerError(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ProviderError) return err;
    throw err;
  }
  throw new Error('expected a ProviderError');
}

describe('OpenAiCompatibleAdapter', () => {
  it('sends the upstream model and credential, without gateway-only fields', async () => {
    const { adapter, sent } = adapterReturning(200, upstreamOk);
    await adapter.complete(request, call());
    expect(sent[0]!.url).toBe('https://api.example.com/v1/chat/completions');
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    expect(JSON.parse(sent[0]!.init.body as string)).toEqual({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
      stream: false,
    });
  });

  it('prefers the base URL on the credential', async () => {
    const { adapter, sent } = adapterReturning(200, upstreamOk);
    await adapter.complete(request, {
      ...call(),
      credential: { secret: 's', baseUrl: 'http://proxy/v1', scope: 'platform' },
    });
    expect(sent[0]!.url).toBe('http://proxy/v1/chat/completions');
  });

  it('returns content and provider-reported usage, keeping the gateway model id', async () => {
    const { adapter } = adapterReturning(200, upstreamOk);
    const result = await adapter.complete(request, call());
    expect(result.response).toMatchObject({
      id: 'chatcmpl-abc',
      model: 'openai/gpt-4o-mini',
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    });
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cachedInputTokens: 4,
      source: 'provider',
    });
  });

  it('estimates usage when the provider omits it', async () => {
    const { adapter } = adapterReturning(200, { ...upstreamOk, usage: undefined });
    const { usage } = await adapter.complete(request, call());
    expect(usage.source).toBe('estimated');
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
  });

  it('passes tool calls through', async () => {
    const toolCalls = [
      { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } },
    ];
    const { adapter } = adapterReturning(200, {
      ...upstreamOk,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: null, tool_calls: toolCalls },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const { response } = await adapter.complete(request, call());
    expect(response.choices[0]).toMatchObject({
      message: { tool_calls: toolCalls },
      finish_reason: 'tool_calls',
    });
  });

  it('maps 429 to a retryable rate_limited error with retry-after', async () => {
    const { adapter } = adapterReturning(
      429,
      { error: { message: 'slow down' } },
      { 'retry-after': '7' },
    );
    const err = await providerError(adapter.complete(request, call()));
    expect(err).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      retryAfterSeconds: 7,
      message: 'slow down',
    });
  });

  it('maps 5xx to a retryable provider_error', async () => {
    const { adapter } = adapterReturning(503, 'upstream down');
    const err = await providerError(adapter.complete(request, call()));
    expect(err).toMatchObject({
      kind: 'provider_error',
      retryable: true,
      fallbackEligible: true,
      upstreamStatus: 503,
    });
  });

  it('maps 400 to invalid_request that is neither retried nor falls back', async () => {
    const { adapter } = adapterReturning(400, {
      error: { message: "Invalid value for 'temperature'" },
    });
    const err = await providerError(adapter.complete(request, call()));
    expect(err).toMatchObject({
      kind: 'invalid_request',
      retryable: false,
      fallbackEligible: false,
    });
  });

  it('maps 401 to provider_auth: not retried, eligible for the next candidate', async () => {
    const { adapter } = adapterReturning(401, { error: { message: 'Incorrect API key' } });
    const err = await providerError(adapter.complete(request, call()));
    expect(err).toMatchObject({ kind: 'provider_auth', retryable: false, fallbackEligible: true });
  });

  it('maps a malformed body to provider_error', async () => {
    const { adapter } = adapterReturning(200, { nope: true });
    expect((await providerError(adapter.complete(request, call()))).kind).toBe('provider_error');
  });

  it('maps an unreachable endpoint to provider_error', async () => {
    const adapter = new OpenAiCompatibleAdapter({
      provider: 'openai',
      defaultBaseUrl: 'http://x',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const err = await providerError(adapter.complete(request, call()));
    expect(err).toMatchObject({
      kind: 'provider_error',
      message: expect.stringContaining('fetch failed'),
    });
  });

  it('maps an aborted call to provider_timeout', async () => {
    const adapter = new OpenAiCompatibleAdapter({
      provider: 'openai',
      defaultBaseUrl: 'http://x',
      fetch: (_url, init) =>
        new Promise((_resolve, reject) =>
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    });
    const err = await providerError(adapter.complete(request, call(AbortSignal.timeout(10))));
    expect(err.kind).toBe('provider_timeout');
  });
});
