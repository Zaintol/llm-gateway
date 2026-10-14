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
