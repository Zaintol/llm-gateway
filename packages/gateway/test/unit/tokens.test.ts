import { describe, expect, it } from 'vitest';
import { estimatePromptTokens } from '../../src/routing/tokens.js';

describe('estimatePromptTokens', () => {
  it('uses the OpenAI tokenizer for OpenAI models', () => {
    const request = {
      model: 'openai/x',
      messages: [{ role: 'user' as const, content: 'hello world' }],
    };
    // "hello world" is 2 tokens in o200k_base, plus 4 tokens of per-message overhead.
    expect(estimatePromptTokens(request, 'openai')).toBe(6);
  });

  it('uses a characters-per-token ratio for providers without a public tokenizer', () => {
    const request = {
      model: 'anthropic/x',
      messages: [{ role: 'user' as const, content: 'x'.repeat(350) }],
    };
    expect(estimatePromptTokens(request, 'anthropic')).toBe(104);
  });

  it('counts tools and adds a fixed estimate per image', () => {
    const base = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }] };
    const withImage = {
      model: 'm',
      messages: [
        {
          role: 'user' as const,
          content: [{ type: 'image_url' as const, image_url: { url: 'https://x' } }],
        },
      ],
    };
    expect(estimatePromptTokens(withImage, 'mock')).toBeGreaterThanOrEqual(1000);
    const withTools = {
      ...base,
      tools: [{ type: 'function' as const, function: { name: 'lookup_weather_forecast' } }],
    };
    expect(estimatePromptTokens(withTools, 'mock')).toBeGreaterThan(
      estimatePromptTokens(base, 'mock'),
    );
  });
});
