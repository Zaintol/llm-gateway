import { buildApp as buildMockProvider } from '@gw/mock-provider';
import type { ChatCompletionRequest } from '@gw/schema';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { StaticCatalog } from '../../src/catalog/catalog.js';
import { chatRoutes } from '../../src/chat/route.js';
import { ExecutionEngine } from '../../src/execution/engine.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { ProviderError, type ProviderErrorKind } from '../../src/providers/errors.js';
import { OpenAiCompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import type { ProviderAdapter, ProviderCall, StreamEvent } from '../../src/providers/types.js';
import { InMemoryRecorder, StaticCredentials, catalogModel, fakeAuth } from '../support/fakes.js';

/**
 * Contract suite: every adapter against the mock provider's OpenAI- and Anthropic-shaped
 * endpoints, for text, streaming, tool calls and every mapped error status. All traffic goes
 * through a guarded fetch that records any request to a non-local host, so the suite proves it
 * makes no outbound internet calls.
 */
let upstream: FastifyInstance;
let upstreamUrl: string;
const outbound: string[] = [];
const guardedFetch: typeof fetch = (input, init) => {
  const url = new URL(String(input));
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    outbound.push(url.href);
    return Promise.reject(new Error(`blocked outbound call to ${url.host}`));
  }
  return fetch(input, init);
};

beforeAll(async () => {
  upstream = buildMockProvider({ logLevel: 'silent' });
  upstreamUrl = await upstream.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  // Keep-alive sockets from the fetch pool would otherwise hold the server open.
  upstream?.server.closeAllConnections();
  await upstream?.close();
  expect(outbound, 'the contract suite must not call the internet').toEqual([]);
});

type Case = {
  name: string;
  adapter: () => ProviderAdapter;
  credential: () => ProviderCall['credential'];
};
const cases: Case[] = [
  {
    name: 'openai',
    adapter: () => new OpenAiCompatibleAdapter({ provider: 'openai', fetch: guardedFetch }),
    credential: () => ({ secret: 'sk-test', baseUrl: `${upstreamUrl}/v1`, scope: 'tenant' }),
  },
  {
    name: 'local',
    adapter: () =>
      new OpenAiCompatibleAdapter({
        provider: 'local',
        requiresCredential: false,
        defaultBaseUrl: `${upstreamUrl}/v1`,
        fetch: guardedFetch,
      }),
    credential: () => null,
  },
  {
    name: 'anthropic',
    adapter: () => new AnthropicAdapter({ fetch: guardedFetch }),
    credential: () => ({ secret: 'sk-ant', baseUrl: upstreamUrl, scope: 'platform' }),
  },
];

const request = (
  model: string,
  extra: Partial<ChatCompletionRequest> = {},
): ChatCompletionRequest => ({
  model: `x/${model}`,
  messages: [{ role: 'user', content: 'hello there' }],
  max_tokens: 64,
  ...extra,
});
const withTool = {
  tools: [
    { type: 'function' as const, function: { name: 'lookup', parameters: { type: 'object' } } },
  ],
};
const call = (
  c: Case,
  upstreamModel: string,
  signal = new AbortController().signal,
): ProviderCall => ({
  upstreamModel,
  credential: c.credential(),
  signal,
});

async function collect(stream: AsyncIterable<StreamEvent>) {
  let text = '';
  const tools = new Map<
    number,
    { id?: string | undefined; name?: string | undefined; args: string }
  >();
  let finish: string | null = null;
  let usage: Extract<StreamEvent, { type: 'usage' }>['usage'] | undefined;
  for await (const event of stream) {
    if (event.type === 'usage') {
      usage = event.usage;
      continue;
    }
    text += event.delta.content ?? '';
    for (const t of event.delta.tool_calls ?? []) {
      const current = tools.get(t.index) ?? { args: '' };
      tools.set(t.index, {
        id: t.id ?? current.id,
        name: t.function?.name || current.name,
        args: current.args + (t.function?.arguments ?? ''),
      });
    }
    finish = event.finishReason ?? finish;
  }
  return { text, tools: [...tools.values()], finish, usage };
}

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ProviderError) return err;
    throw err;
  }
  throw new Error('expected a ProviderError');
}

const ERRORS: Array<[string, ProviderErrorKind, boolean]> = [
  ['rate-limit', 'rate_limited', true],
  ['server-error', 'provider_error', true],
  ['bad-request', 'invalid_request', false],
  ['unauthorized', 'provider_auth', false],
  ['forbidden', 'provider_auth', false],
  ['not-found', 'invalid_request', false],
];

describe.each(cases)('$name adapter contract', (c) => {
  it('completes a text request with provider usage', async () => {
    const result = await c.adapter().complete(request('m'), call(c, 'm'));
    expect(result.response.choices[0]).toMatchObject({
      message: { content: 'Mock reply to: hello there' },
      finish_reason: 'stop',
    });
    expect(result.usage).toMatchObject({ source: 'provider' });
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  it('streams a text request ending with usage', async () => {
    const out = await collect(c.adapter().stream({ ...request('m'), stream: true }, call(c, 'm')));
    expect(out.text).toBe('Mock reply to: hello there');
    expect(out.finish).toBe('stop');
    expect(out.usage?.outputTokens).toBeGreaterThan(0);
  });

  it('returns a tool call', async () => {
    const result = await c.adapter().complete(request('m-tool', withTool), call(c, 'm-tool'));
    expect(result.response.choices[0]).toMatchObject({
      message: {
        tool_calls: [
          { type: 'function', function: { name: 'lookup', arguments: '{"query":"hello there"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    });
  });

  it('streams a tool call in fragments', async () => {
    const out = await collect(
      c.adapter().stream({ ...request('m-tool', withTool), stream: true }, call(c, 'm-tool')),
    );
    expect(out.tools).toEqual([
      { id: expect.any(String), name: 'lookup', args: '{"query":"hello there"}' },
    ]);
    expect(out.finish).toBe('tool_calls');
  });

  it.each(ERRORS)(
    'maps %s to %s (retryable: %s) when completing and streaming',
    async (model, kind, retryable) => {
      const adapter = c.adapter();
      const completeErr = await failure(adapter.complete(request(model), call(c, model)));
      expect(completeErr).toMatchObject({ kind, retryable });
      const streamErr = await failure(
        collect(adapter.stream({ ...request(model), stream: true }, call(c, model))),
      );
      expect(streamErr).toMatchObject({ kind, retryable });
    },
  );

  it('maps a slow upstream to provider_timeout', async () => {
    const err = await failure(
      c.adapter().complete(request('slow-500'), call(c, 'slow-500', AbortSignal.timeout(50))),
    );
    expect(err.kind).toBe('provider_timeout');
  });

  if (c.name !== 'anthropic') {
    it('estimates usage when the endpoint omits it', async () => {
      const result = await c.adapter().complete(request('no-usage'), call(c, 'no-usage'));
      expect(result.usage.source).toBe('estimated');
      expect(result.usage.outputTokens).toBeGreaterThan(0);
    });
  }
});

describe('mid-stream failure through the gateway', () => {
  it('ends with an error chunk and meters the request as partial when the mock fails after 5 chunks', async () => {
    await fetch(`${upstreamUrl}/mock/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ match: 'chunks-40', failAfterChunks: 5 }),
    });
    const catalog = new StaticCatalog([
      catalogModel({ id: 'mock/long', upstreamModel: 'chunks-40' }),
    ]);
    const recorder = new InMemoryRecorder();
    const fakes = fakeAuth();
    const { key } = fakes.store.add();
    const gateway = buildApp({
      logLevel: 'silent',
      readinessChecks: {},
      readinessTimeoutMs: 100,
      auth: fakes.auth,
      dataPlaneRoutes: [
        chatRoutes({
          providers: new ProviderRegistry(
            [
              new OpenAiCompatibleAdapter({
                provider: 'mock',
                requiresCredential: false,
                defaultBaseUrl: `${upstreamUrl}/v1`,
                fetch: guardedFetch,
              }),
            ],
            catalog,
          ),
          catalog,
          credentials: new StaticCredentials(),
          engine: new ExecutionEngine({ sleep: async () => {} }),
          usage: recorder,
        }),
      ],
    });
    try {
      const res = await gateway.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${key}` },
        payload: { model: 'mock/long', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      });
      const events = res.body
        .split('\n\n')
        .filter((b) => b.startsWith('data: '))
        .map((b) => b.slice(6));
      const content = events.filter(
        (e) => e !== '[DONE]' && JSON.parse(e).choices?.[0]?.delta?.content,
      );
      expect(content).toHaveLength(5);
      expect(JSON.parse(events.at(-2)!)).toMatchObject({ error: { code: 'stream_interrupted' } });
      expect(events.at(-1)).toBe('[DONE]');
      const [event] = await recorder.waitFor(1);
      expect(event).toMatchObject({ status: 'partial', usageSource: 'estimated' });
    } finally {
      await gateway.close();
      await fetch(`${upstreamUrl}/mock/faults`, { method: 'DELETE' });
    }
  });
});
