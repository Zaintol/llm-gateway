import { describe, expect, it } from 'vitest';
import { chatCompletionRequestSchema, knownRequestFields } from '../src/index.js';

describe('chatCompletionRequestSchema', () => {
  it('accepts text, image and tool messages', () => {
    const parsed = chatCompletionRequestSchema.parse({
      model: 'openai/gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Be brief.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
          ],
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
      ],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      response_format: { type: 'json_object' },
      max_tokens: 100,
    });
    expect(parsed.messages).toHaveLength(4);
  });

  it('strips unknown top-level and nested fields', () => {
    const parsed = chatCompletionRequestSchema.parse({
      model: 'm',
      messages: [{ role: 'user', content: 'hi', secret_flag: true }],
      logit_bias: { 1: 2 },
    });
    expect(parsed).toEqual({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  });

  it('rejects a request without messages, naming the field', () => {
    const result = chatCompletionRequestSchema.safeParse({ model: 'm' });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.path).toEqual(['messages']);
  });

  it('knows its top-level fields', () => {
    expect(knownRequestFields.has('messages')).toBe(true);
    expect(knownRequestFields.has('logit_bias')).toBe(false);
  });
});
