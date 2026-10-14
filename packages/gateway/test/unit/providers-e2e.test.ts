import { buildApp as buildMockProvider } from '@gw/mock-provider';
import type { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { chatRoutes } from '../../src/chat/route.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { OpenAiCompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import { StaticCredentials, fakeAuth } from '../support/fakes.js';

/** OpenAI SDK -> gateway -> Anthropic and local adapters -> mock provider. */
let upstream: FastifyInstance;
let gateway: FastifyInstance;
let upstreamUrl: string;
let client: OpenAI;

beforeAll(async () => {
  upstream = buildMockProvider({ logLevel: 'silent' });
  upstreamUrl = await upstream.listen({ host: '127.0.0.1', port: 0 });
  const fakes = fakeAuth();
  const { key } = fakes.store.add();
  gateway = buildApp({
    logLevel: 'silent',
    readinessChecks: {},
    readinessTimeoutMs: 100,
    auth: fakes.auth,
    dataPlaneRoutes: [
      chatRoutes({
        providers: new ProviderRegistry([
          new AnthropicAdapter(),
          new OpenAiCompatibleAdapter({
            provider: 'local',
            requiresCredential: false,
            defaultBaseUrl: `${upstreamUrl}/v1`,
          }),
          new OpenAiCompatibleAdapter({
            provider: 'offline',
            requiresCredential: false,
            defaultBaseUrl: 'http://127.0.0.1:9/v1',
          }),
        ]),
        credentials: new StaticCredentials({
          anthropic: { secret: 'sk-ant-test', baseUrl: upstreamUrl, scope: 'platform' },
        }),
        providerTimeoutMs: 5000,
      }),
    ],
  });
  client = new OpenAI({
    apiKey: key,
    baseURL: `${await gateway.listen({ host: '127.0.0.1', port: 0 })}/v1`,
    maxRetries: 0,
  });
});

afterAll(async () => {
  await gateway?.close();
  await upstream?.close();
});

const lastUpstream = async () =>
  (
    (await (await fetch(`${upstreamUrl}/mock/requests`)).json()) as Array<{
      path: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    }>
  )[0]!;

describe('anthropic through the gateway', () => {
  it('sends a top-level system field upstream and returns an OpenAI-shaped completion', async () => {
    const res = await client.chat.completions.create({
      model: 'anthropic/claude-mock',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
      ],
    });
    expect(res.object).toBe('chat.completion');
    expect(res.choices[0]!.message.content).toBe('Mock reply to: first second');
    expect(res.usage?.total_tokens).toBeGreaterThan(0);

    const sent = await lastUpstream();
    expect(sent.path).toBe('/v1/messages');
    expect(sent.headers['x-api-key']).toBe('sk-ant-test');
    expect(sent.body.system).toBe('Be brief.');
    expect(sent.body.max_tokens).toBe(4096);
    expect(sent.body.messages).toHaveLength(1);
  });

  it('returns a tool call with function name, JSON arguments and finish_reason tool_calls', async () => {
    const res = await client.chat.completions.create({
      model: 'anthropic/claude-tool',
      messages: [{ role: 'user', content: 'weather in Paris' }],
      tools: [
        { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } },
      ],
    });
    const choice = res.choices[0]!;
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.tool_calls?.[0]).toMatchObject({
      type: 'function',
      function: { name: 'get_weather', arguments: '{"query":"weather in Paris"}' },
    });
  });

  it('returns 400 invalid_request when the conversation starts with an assistant message', async () => {
    const err = (await client.chat.completions
      .create({
        model: 'anthropic/claude-mock',
        messages: [
          { role: 'assistant', content: 'Hi, how can I help?' },
          { role: 'user', content: 'x' },
        ],
      })
      .catch((e: unknown) => e)) as InstanceType<typeof OpenAI.APIError>;
    expect(err.status).toBe(400);
    expect(err.type).toBe('invalid_request');
    expect(err.message).toMatch(/start with a user message/);
  });

  it('flags json_object as emulated', async () => {
    const { response } = await client.chat.completions
      .create({
        model: 'anthropic/claude-mock',
        messages: [{ role: 'user', content: 'x' }],
        response_format: { type: 'json_object' },
      })
      .withResponse();
    expect(response.headers.get('x-gateway-emulated')).toBe('json_mode');
  });
});

describe('local models through the gateway', () => {
  it('returns an OpenAI-shaped completion with token counts and no API key upstream', async () => {
    const res = await client.chat.completions.create({
      model: 'local/llama3',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.choices[0]!.message.content).toBe('Mock reply to: hello');
    expect(res.usage).toMatchObject({
      prompt_tokens: expect.any(Number),
      completion_tokens: expect.any(Number),
    });
    const sent = await lastUpstream();
    expect(sent.body.model).toBe('llama3');
    expect(sent.headers.authorization).toBeUndefined();
  });

  it('estimates non-zero token counts when the endpoint omits usage', async () => {
    const res = await client.chat.completions.create({
      model: 'local/no-usage',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.usage!.prompt_tokens).toBeGreaterThan(0);
    expect(res.usage!.completion_tokens).toBeGreaterThan(0);
  });

  it('reports an unreachable endpoint as a 502 provider_error', async () => {
    const err = (await client.chat.completions
      .create({ model: 'offline/llama3', messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e)) as InstanceType<typeof OpenAI.APIError>;
    expect(err.status).toBe(502);
    expect(err.type).toBe('provider_error');
  });
});
