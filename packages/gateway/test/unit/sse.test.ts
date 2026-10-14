import { describe, expect, it } from 'vitest';
import { parseSse } from '../../src/providers/sse.js';

async function* bytes(...parts: string[]) {
  for (const part of parts) yield new TextEncoder().encode(part);
}

async function collect(...parts: string[]) {
  const events = [];
  for await (const event of parseSse(bytes(...parts))) events.push(event);
  return events;
}

describe('parseSse', () => {
  it('parses events split across chunks, skipping comments', async () => {
    expect(
      await collect(
        'data: {"a"',
        ':1}\n\n: ping\n\nevent: message_stop\ndata: {}\n\n',
        'data: [DONE]\n\n',
      ),
    ).toEqual([{ data: '{"a":1}' }, { event: 'message_stop', data: '{}' }, { data: '[DONE]' }]);
  });

  it('handles CRLF line endings, multi-line data and a trailing event without a blank line', async () => {
    expect(await collect('data: one\r\ndata: two\r\n\r\ndata: tail')).toEqual([
      { data: 'one\ntwo' },
      { data: 'tail' },
    ]);
  });
});
