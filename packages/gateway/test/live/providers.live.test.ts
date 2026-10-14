import { describe, expect, it } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { OpenAiCompatibleAdapter } from '../../src/providers/openai-compatible.js';
import type { ProviderAdapter, StreamEvent } from '../../src/providers/types.js';

/**
 * Verifies the adapters against the real provider APIs, so drift in their wire formats shows up
 * here before users hit it. Each provider runs only when its key is set; costs a fraction of a cent.
 */
const providers: Array<{
  name: string;
  key: string | undefined;
  model: string;
  adapter: () => ProviderAdapter;
}> = [
  {
    name: 'openai',
    key: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_LIVE_MODEL ?? 'gpt-4o-mini',
    adapter: () =>
      new OpenAiCompatibleAdapter({
        provider: 'openai',
        defaultBaseUrl: 'https://api.openai.com/v1',
      }),
  },
  {
    name: 'anthropic',
    key: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_LIVE_MODEL ?? 'claude-haiku-4-5',
    adapter: () => new AnthropicAdapter(),
  },
];

const request = (model: string) => ({
  model: `live/${model}`,
  max_tokens: 16,
  messages: [{ role: 'user' as const, content: 'Reply with the single word: pong' }],
});

describe.each(providers)('$name live contract', ({ key, model, adapter }) => {
  const call = () => ({
    upstreamModel: model,
    credential: key ? { secret: key, baseUrl: null, scope: 'platform' as const } : null,
    signal: AbortSignal.timeout(30_000),
  });

  it.skipIf(!key)('completes with provider-reported usage', async () => {
    const result = await adapter().complete(request(model), call());
    expect(result.response.choices[0]!.message.content?.toLowerCase()).toContain('pong');
    expect(result.usage.source).toBe('provider');
  });

  it.skipIf(!key)('streams with provider-reported usage', async () => {
    let text = '';
    let usage: Extract<StreamEvent, { type: 'usage' }>['usage'] | undefined;
    for await (const event of adapter().stream({ ...request(model), stream: true }, call())) {
      if (event.type === 'usage') usage = event.usage;
      else text += event.delta.content ?? '';
    }
    expect(text.toLowerCase()).toContain('pong');
    expect(usage?.source).toBe('provider');
  });
});
