import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
afterEach(() => app?.close());

const chat = (model: string) =>
  app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: { model, messages: [{ role: 'user', content: 'hello there' }] },
  });

describe('mock provider', () => {
  it('reports healthy', async () => {
    app = buildApp({ logLevel: 'silent' });
    expect((await app.inject('/healthz')).statusCode).toBe(200);
  });

  it('answers a chat completion deterministically with usage', async () => {
    app = buildApp({ logLevel: 'silent' });
    const res = await chat('gpt-4o-mini');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      object: 'chat.completion',
      model: 'gpt-4o-mini',
      choices: [
        {
          message: { role: 'assistant', content: 'Mock reply to: hello there' },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: expect.any(Number),
        completion_tokens: 7,
        total_tokens: expect.any(Number),
      },
    });
  });

  it.each([
    ['rate-limit', 429],
    ['server-error', 500],
    ['bad-request', 400],
    ['unauthorized', 401],
  ])('returns an OpenAI-shaped error for a %s model', async (behaviour, status) => {
    app = buildApp({ logLevel: 'silent' });
    const res = await chat(`mock-${behaviour}`);
    expect(res.statusCode).toBe(status);
    expect(res.json().error).toMatchObject({
      message: expect.any(String),
      type: expect.any(String),
    });
  });

  it('omits usage for a no-usage model', async () => {
    app = buildApp({ logLevel: 'silent' });
    expect((await chat('mock-no-usage')).json().usage).toBeUndefined();
  });

  it('records received requests, newest first', async () => {
    app = buildApp({ logLevel: 'silent' });
    await chat('first');
    await chat('second');
    const history = (await app.inject('/mock/requests')).json();
    expect(history.map((r: { body: { model: string } }) => r.body.model)).toEqual([
      'second',
      'first',
    ]);
  });
});

describe('mock provider: anthropic messages', () => {
  const messages = (model: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model,
        max_tokens: 50,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        ...extra,
      },
    });

  it('answers with a text block and usage', async () => {
    app = buildApp({ logLevel: 'silent' });
    const res = await messages('claude-mock');
    expect(res.json()).toMatchObject({
      type: 'message',
      content: [{ type: 'text', text: 'Mock reply to: hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: expect.any(Number), output_tokens: expect.any(Number) },
    });
  });

  it('calls the first tool for a tool model', async () => {
    app = buildApp({ logLevel: 'silent' });
    const res = await messages('claude-tool', { tools: [{ name: 'lookup', input_schema: {} }] });
    expect(res.json()).toMatchObject({
      content: [{ type: 'tool_use', name: 'lookup', input: { query: 'hi' } }],
      stop_reason: 'tool_use',
    });
  });

  it('requires max_tokens like the real API', async () => {
    app = buildApp({ logLevel: 'silent' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'claude-mock', messages: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('mock provider: fault rules', () => {
  const post = (model: string, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model, messages: [{ role: 'user', content: 'hi' }], ...extra },
    });

  it('applies a matching fault rule until it is cleared', async () => {
    app = buildApp({ logLevel: 'silent' });
    await app.inject({
      method: 'POST',
      url: '/mock/faults',
      payload: { match: 'primary', status: 503 },
    });
    expect((await post('primary-model')).statusCode).toBe(503);
    expect((await post('other-model')).statusCode).toBe(200);
    await app.inject({ method: 'DELETE', url: '/mock/faults' });
    expect((await post('primary-model')).statusCode).toBe(200);
  });

  it('honours an error rate', async () => {
    let n = 0;
    app = buildApp({ logLevel: 'silent', random: () => (n++ % 2 === 0 ? 0.1 : 0.9) });
    await app.inject({
      method: 'POST',
      url: '/mock/faults',
      payload: { match: '*', status: 500, errorRate: 0.5 },
    });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await post('any')).statusCode);
    expect(statuses).toEqual([500, 200, 500, 200]);
  });

  it('drops usage when a rule says so', async () => {
    app = buildApp({ logLevel: 'silent' });
    await app.inject({
      method: 'POST',
      url: '/mock/faults',
      payload: { match: '*', noUsage: true },
    });
    expect((await post('any')).json().usage).toBeUndefined();
  });

  it('rejects a rule without a match', async () => {
    app = buildApp({ logLevel: 'silent' });
    expect(
      (await app.inject({ method: 'POST', url: '/mock/faults', payload: { status: 500 } }))
        .statusCode,
    ).toBe(400);
  });
});

describe('mock provider: OpenAI tool calls and statuses', () => {
  it('returns a tool call for a tool model', async () => {
    app = buildApp({ logLevel: 'silent' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'mock-tool',
        messages: [{ role: 'user', content: 'paris' }],
        tools: [{ type: 'function', function: { name: 'weather' } }],
      },
    });
    expect(res.json().choices[0]).toMatchObject({
      message: {
        content: null,
        tool_calls: [
          { type: 'function', function: { name: 'weather', arguments: '{"query":"paris"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    });
  });

  it.each([
    ['forbidden', 403],
    ['not-found', 404],
    ['status-418', 418],
  ])('maps %s to HTTP %i', async (name, status) => {
    app = buildApp({ logLevel: 'silent' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: `m-${name}`, messages: [] },
    });
    expect(res.statusCode).toBe(status);
  });
});
