import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

/**
 * Fake OpenAI-compatible upstream for tests, load tests and the public demo.
 *
 * Behaviour is chosen by the requested model name, so a gateway route can target a failure mode
 * without special headers:
 *   *rate-limit*    429 with an OpenAI error body
 *   *server-error*  500
 *   *bad-request*   400
 *   *unauthorized*  401
 *   *no-usage*      200 without a usage block
 *   *slow-<ms>*     delays the response by <ms> milliseconds
 * Anything else answers 200 with a deterministic reply.
 *
 * POST /v1/messages speaks the Anthropic Messages API with the same failure modes, plus:
 *   *tool*          answers with a tool_use block for the first tool in the request
 *
 *
 * With `stream: true` both endpoints answer with server-sent events. Streaming modifiers:
 *   *chunks-<n>*        emit n content chunks ("tok0 tok1 ...") instead of the echo reply
 *   *chunk-delay-<ms>*  wait between chunks (default 2 ms)
 *   *fail-after-<n>*    drop the connection after n chunks (mid-stream failure)
 *   *stall-after-<n>*   stop sending after n chunks but keep the connection open (idle)
 * Requests the client abandons mid-stream are recorded with `aborted: true` in /mock/requests.
 *
 * GW-10.1 extends this with Gemini shapes and runtime fault injection.
 */

type RecordedRequest = {
  path: string;
  headers: Record<string, unknown>;
  body: unknown;
  aborted?: boolean;
  abortedAt?: number;
};

const numberAfter = (model: string, label: string) => {
  const match = new RegExp(`${label}-(\\d+)`).exec(model);
  return match ? Number(match[1]) : undefined;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type StreamPlan = { pieces: string[]; delayMs: number; failAfter?: number; stallAfter?: number };

function streamPlan(model: string, replyText: string): StreamPlan {
  const count = numberAfter(model, 'chunks');
  const pieces = count
    ? Array.from({ length: count }, (_, i) => `tok${i} `)
    : replyText.split(/(?<= )/);
  return {
    pieces,
    delayMs: numberAfter(model, 'chunk-delay') ?? 2,
    ...(numberAfter(model, 'fail-after') !== undefined
      ? { failAfter: numberAfter(model, 'fail-after')! }
      : {}),
    ...(numberAfter(model, 'stall-after') !== undefined
      ? { stallAfter: numberAfter(model, 'stall-after')! }
      : {}),
  };
}

/**
 * Writes SSE frames produced by `frames(i)` for each piece, honouring the failure modifiers.
 * Returns once the stream ends, fails, stalls, or the client goes away.
 */
async function writeStream(
  reply: FastifyReply,
  entry: RecordedRequest,
  plan: StreamPlan,
  frames: { start: string[]; piece: (text: string, i: number) => string; end: string[] },
) {
  reply.hijack();
  const res = reply.raw;
  let closed = false;
  res.on('close', () => {
    if (!res.writableFinished) {
      closed = true;
      entry.aborted = true;
      entry.abortedAt = Date.now();
    }
  });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const frame of frames.start) res.write(frame);
  for (const [i, piece] of plan.pieces.entries()) {
    if (closed) return;
    if (plan.failAfter !== undefined && i >= plan.failAfter) {
      res.destroy();
      return;
    }
    if (plan.stallAfter !== undefined && i >= plan.stallAfter) return; // idle until the client leaves
    res.write(frames.piece(piece, i));
    await sleep(plan.delayMs);
  }
  if (closed) return;
  for (const frame of frames.end) res.write(frame);
  res.end();
}

const estimateTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));

function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  const last = [...messages].reverse().find((m) => m?.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return last.content
      .filter((p: { type?: string }) => p?.type === 'text')
      .map((p: { text?: string }) => p.text ?? '')
      .join(' ');
  }
  return '';
}

const openAiError = (type: string, code: string, message: string) => ({
  error: { message, type, code, param: null },
});

export function buildApp(
  options: { logLevel?: string; historySize?: number } = {},
): FastifyInstance {
  const app = Fastify({ logger: { level: options.logLevel ?? 'info' } });
  const history: RecordedRequest[] = [];
  let counter = 0;

  app.get('/healthz', async () => ({ status: 'ok' }));

  /** Most recent requests first; lets tests assert exactly what the gateway sent upstream. */
  app.get('/mock/requests', async () => history);
  app.delete('/mock/requests', async (_req, reply) => {
    history.length = 0;
    return reply.code(204).send();
  });

  app.post('/v1/chat/completions', async (request, reply) => {
    const body = (request.body ?? {}) as {
      model?: string;
      messages?: unknown;
      max_tokens?: number;
    };
    history.unshift({ path: request.url, headers: request.headers, body });
    history.length = Math.min(history.length, options.historySize ?? 50);

    const model = body.model ?? 'mock';
    const delay = /slow-(\d+)/.exec(model);
    if (delay) await new Promise((r) => setTimeout(r, Number(delay[1])));

    if (model.includes('rate-limit')) {
      return reply
        .code(429)
        .header('retry-after', '1')
        .send(openAiError('rate_limit_error', 'rate_limit_exceeded', 'Rate limit reached (mock)'));
    }
    if (model.includes('server-error')) {
      return reply
        .code(500)
        .send(openAiError('server_error', 'server_error', 'Upstream exploded (mock)'));
    }
    if (model.includes('bad-request')) {
      return reply
        .code(400)
        .send(
          openAiError(
            'invalid_request_error',
            'invalid_value',
            "Invalid value for 'temperature' (mock)",
          ),
        );
    }
    if (model.includes('unauthorized')) {
      return reply
        .code(401)
        .send(openAiError('invalid_request_error', 'invalid_api_key', 'Incorrect API key (mock)'));
    }

    const prompt = JSON.stringify(body.messages ?? []);
    const content = `Mock reply to: ${lastUserText(body.messages)}`.trim();
    const promptTokens = estimateTokens(prompt);
    const completionTokens = estimateTokens(content);
    counter += 1;

    if ((body as { stream?: boolean }).stream) {
      const id = `chatcmpl-mock-${counter}`;
      const plan = streamPlan(model, content);
      const includeUsage =
        (body as { stream_options?: { include_usage?: boolean } }).stream_options?.include_usage ===
        true;
      const chunk = (delta: object, finish: string | null, extra: object = {}) =>
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      const streamed = plan.pieces.join('');
      await writeStream(reply, history[0]!, plan, {
        start: [chunk({ role: 'assistant', content: '' }, null)],
        piece: (text) => chunk({ content: text }, null),
        end: [
          chunk({}, 'stop'),
          ...(includeUsage && !model.includes('no-usage')
            ? [
                `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: estimateTokens(streamed), total_tokens: promptTokens + estimateTokens(streamed) } })}\n\n`,
              ]
            : []),
          'data: [DONE]\n\n',
        ],
      });
      return reply;
    }
    return {
      id: `chatcmpl-mock-${counter}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      ...(model.includes('no-usage')
        ? {}
        : {
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
          }),
    };
  });

  app.post('/v1/messages', async (request, reply) => {
    const body = (request.body ?? {}) as {
      model?: string;
      messages?: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
      tools?: Array<{ name: string }>;
      max_tokens?: number;
    };
    history.unshift({ path: request.url, headers: request.headers, body });
    history.length = Math.min(history.length, options.historySize ?? 50);

    const model = body.model ?? 'mock';
    const anthropicError = (status: number, type: string, message: string) =>
      reply.code(status).send({ type: 'error', error: { type, message } });
    if (model.includes('rate-limit'))
      return anthropicError(429, 'rate_limit_error', 'Rate limited (mock)');
    if (model.includes('server-error'))
      return anthropicError(529, 'overloaded_error', 'Overloaded (mock)');
    if (model.includes('bad-request'))
      return anthropicError(400, 'invalid_request_error', 'Bad request (mock)');
    if (model.includes('unauthorized'))
      return anthropicError(401, 'authentication_error', 'invalid x-api-key (mock)');
    if (!body.max_tokens)
      return anthropicError(400, 'invalid_request_error', 'max_tokens: Field required');

    const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
    if ((body as { stream?: boolean }).stream) {
      const userText = (lastUser?.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ');
      const plan = streamPlan(model, `Mock reply to: ${userText}`.trim());
      const event = (type: string, data: object) =>
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      const inputTokens = estimateTokens(JSON.stringify(body.messages ?? []));
      counter += 1;
      await writeStream(reply, history[0]!, plan, {
        start: [
          event('message_start', {
            message: {
              id: `msg_mock_${counter}`,
              type: 'message',
              role: 'assistant',
              model,
              content: [],
              usage: { input_tokens: inputTokens, output_tokens: 1 },
            },
          }),
          event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
          event('ping', {}),
        ],
        piece: (text) =>
          event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
        end: [
          event('content_block_stop', { index: 0 }),
          event('message_delta', {
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: estimateTokens(plan.pieces.join('')) },
          }),
          event('message_stop', {}),
        ],
      });
      return reply;
    }
    const userText = (lastUser?.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ');
    const firstTool = body.tools?.[0];
    const useTool = model.includes('tool') && firstTool;
    const content = useTool
      ? [
          {
            type: 'tool_use',
            id: `toolu_mock_${counter + 1}`,
            name: firstTool.name,
            input: { query: userText },
          },
        ]
      : [{ type: 'text', text: `Mock reply to: ${userText}`.trim() }];
    counter += 1;
    return {
      id: `msg_mock_${counter}`,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: useTool ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: estimateTokens(JSON.stringify(body.messages ?? [])),
        output_tokens: estimateTokens(JSON.stringify(content)),
      },
    };
  });

  return app;
}
