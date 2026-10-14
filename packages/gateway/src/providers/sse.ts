export type SseEvent = { event?: string; data: string };

/**
 * Parses a text/event-stream body into events. Comment lines (": ping") are skipped and
 * multi-line data fields are joined with newlines, per the SSE spec.
 */
export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const event = parseBlock(block);
      if (event) yield event;
    }
  }
  const tail = parseBlock(buffer + decoder.decode());
  if (tail) yield tail;
}

function parseBlock(block: string): SseEvent | undefined {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return undefined;
  return event === undefined ? { data: data.join('\n') } : { event, data: data.join('\n') };
}
