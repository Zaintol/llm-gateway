import { buildApp as buildMockProvider } from '@gw/mock-provider';
import type { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { StaticCatalog } from '../../src/catalog/catalog.js';
import { chatRoutes } from '../../src/chat/route.js';
import { ExecutionEngine } from '../../src/execution/engine.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { OpenAiCompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { StaticCredentials, catalogModel, fakeAuth } from '../support/fakes.js';

/** OpenAI SDK / raw fetch -> gateway -> real adapters -> mock provider, all over HTTP. */
let upstream: FastifyInstance;
let gateway: FastifyInstance;
let upstreamUrl: string;
let gatewayUrl: string;
let apiKey: string;
let client: OpenAI;

const model = (id: string, upstreamModel: string) =>
  catalogModel({ id, provider: id.split('/')[0]!, upstreamModel });

beforeAll(async () => {
  upstream = buildMockProvider({ logLevel: 'silent' });
  upstreamUrl = await upstream.listen({ host: '127.0.0.1', port: 0 });
  const catalog = new StaticCatalog(
    [
      model('anthropic/claude', 'claude-mock'),
      model('openai/gpt', 'gpt'),
      model('openai/broken', 'server-error'),
      model('openai/fails-mid-stream', 'chunks-40-fail-after-20'),
      model('openai/stalls', 'chunks-10-stall-after-3'),
      model('openai/slow-first-token', 'slow-1000'),
      model('openai/endless', 'chunks-2000-chunk-delay-10'),
    ],
    [
      {
        id: 'gw/broken-then-anthropic',
        description: '',
        requirements: {},
        fallbackChain: ['openai/broken', 'anthropic/claude'],
        enabled: true,
      },
      {
        id: 'gw/slow-then-gpt',
        description: '',
        requirements: {},
        fallbackChain: ['openai/slow-first-token', 'openai/gpt'],
        enabled: true,
      },
    ],
  );
  const fakes = fakeAuth();
  apiKey = fakes.store.add().key;
  gateway = buildApp({
    logLevel: 'silent',
    readinessChecks: {},
    readinessTimeoutMs: 100,
    auth: fakes.auth,
    dataPlaneRoutes: [
      chatRoutes({
        providers: new ProviderRegistry(
          [
            new OpenAiCompatibleAdapter({
              provider: 'openai',
              defaultBaseUrl: `${upstreamUrl}/v1`,
            }),
            new AnthropicAdapter(),
          ],
          catalog,
        ),
        catalog,
        credentials: new StaticCredentials({
          openai: { secret: 'sk-test', baseUrl: null, scope: 'tenant' },
          anthropic: { secret: 'sk-ant-test', baseUrl: upstreamUrl, scope: 'tenant' },
        }),
        engine: new ExecutionEngine({ sleep: async () => {}, firstTokenTimeoutMs: 300 }),
        stream: { idleTimeoutMs: 300, heartbeatMs: 10_000 },
      }),
    ],
  });
  gatewayUrl = await gateway.listen({ host: '127.0.0.1', port: 0 });
  client = new OpenAI({ apiKey, baseURL: `${gatewayUrl}/v1`, maxRetries: 0 });
});

afterAll(async () => {
  await gateway?.close();
  await upstream?.close();
});

type Recorded = { path: string; body: { model: string }; aborted?: boolean; abortedAt?: number };
const upstreamRequests = async (): Promise<Recorded[]> =>
  (await fetch(`${upstreamUrl}/mock/requests`)).json() as Promise<Recorded[]>;
const clearUpstream = () => fetch(`${upstreamUrl}/mock/requests`, { method: 'DELETE' });

/** Raw SSE `data:` payloads from the gateway, for assertions the SDK would hide. */
async function rawStream(
  modelId: string,
): Promise<{ status: number; headers: Headers; events: string[] }> {
  const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  const text = await res.text();
  const events = text
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => block.slice('data: '.length));
  return { status: res.status, headers: res.headers, events };
}

describe('streaming (GW-2.6)', () => {
  it('streams incremental deltas from anthropic through the OpenAI SDK and terminates', async () => {
    const stream = await client.chat.completions.create({
      model: 'anthropic/claude',
      stream: true,
      messages: [{ role: 'user', content: 'hello there friend' }],
    });
    const deltas: string[] = [];
    let finish: string | null = null;
    for await (const chunk of stream) {
      expect(chunk.object).toBe('chat.completion.chunk');
      expect(chunk.model).toBe('anthropic/claude');
      const choice = chunk.choices[0];
      if (choice?.delta.content) deltas.push(choice.delta.content);
      if (choice?.finish_reason) finish = choice.finish_reason;
    }
    expect(deltas.length).toBeGreaterThan(3);
    expect(deltas.join('')).toBe('Mock reply to: hello there friend');
    expect(finish).toBe('stop');
  });

  it('puts prompt, completion and total tokens in the last chunk when include_usage is set', async () => {
    const stream = await client.chat.completions.create({
      model: 'openai/gpt',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'count tokens' }],
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const last = chunks.at(-1)!;
    expect(last.choices).toEqual([]);
    expect(last.usage).toMatchObject({
      prompt_tokens: expect.any(Number),
      completion_tokens: expect.any(Number),
      total_tokens: last.usage!.prompt_tokens + last.usage!.completion_tokens,
    });
    expect(chunks.slice(0, -1).every((c) => c.usage === null)).toBe(true);
  });

  it('falls back before the first chunk, so the client sees one uninterrupted stream', async () => {
    const { data: stream, response } = await client.chat.completions
      .create({
        model: 'gw/broken-then-anthropic',
        stream: true,
        messages: [{ role: 'user', content: 'resilient' }],
      })
      .withResponse();
    let text = '';
    for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? '';
    expect(text).toBe('Mock reply to: resilient');
    expect(response.headers.get('x-gateway-provider')).toBe('anthropic');
    expect(response.headers.get('x-gateway-attempts')).toBe('4');
  });

  it('ends a stream that fails after 20 chunks with an error chunk then [DONE], without fallback', async () => {
    await clearUpstream();
    const { status, headers, events } = await rawStream('openai/fails-mid-stream');
    expect(status).toBe(200);
    expect(headers.get('x-gateway-attempts')).toBe('1');
    const contentChunks = events.filter(
      (e) => e !== '[DONE]' && JSON.parse(e).choices?.[0]?.delta?.content,
    );
    expect(contentChunks).toHaveLength(20);
    expect(JSON.parse(events.at(-2)!)).toMatchObject({
      error: { type: 'provider_error', code: 'stream_interrupted' },
    });
    expect(events.at(-1)).toBe('[DONE]');
    expect(await upstreamRequests()).toHaveLength(1);
  });

  it('aborts the upstream request within 1 second when the client disconnects', async () => {
    await clearUpstream();
    const controller = new AbortController();
    const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/endless',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.read();
    const disconnectedAt = Date.now();
    controller.abort();

    let recorded: Recorded | undefined;
    while (Date.now() - disconnectedAt < 1000) {
      recorded = (await upstreamRequests())[0];
      if (recorded?.aborted) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(recorded?.aborted).toBe(true);
    expect(recorded!.abortedAt! - disconnectedAt).toBeLessThan(1000);
  });
});

describe('streaming timeouts (GW-3.1)', () => {
  it('moves to the next candidate when the first token does not arrive in time', async () => {
    const { data: stream, response } = await client.chat.completions
      .create({
        model: 'gw/slow-then-gpt',
        stream: true,
        messages: [{ role: 'user', content: 'quick' }],
      })
      .withResponse();
    let text = '';
    for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? '';
    expect(text).toBe('Mock reply to: quick');
    expect(response.headers.get('x-gateway-model')).toBe('openai/gpt');
  });

  it('ends an idle stream with an error chunk then [DONE]', async () => {
    const { events } = await rawStream('openai/stalls');
    expect(JSON.parse(events.at(-2)!)).toMatchObject({
      error: { type: 'provider_timeout', code: 'stream_idle_timeout' },
    });
    expect(events.at(-1)).toBe('[DONE]');
  });
});

describe('streaming errors before the first byte', () => {
  it('are returned as normal JSON errors with a status code', async () => {
    const res = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/broken',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });
});
