import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

/**
 * Fake upstream for tests, load tests and the public demo. It speaks the OpenAI chat completions
 * API (POST /v1/chat/completions) and the Anthropic Messages API (POST /v1/messages), streaming
 * included, and never calls anything external.
 *
 * Behaviour comes from two sources, merged per request:
 *
 * 1. Modifiers in the requested model name, so a gateway route can target a failure mode:
 *      rate-limit · server-error · bad-request · unauthorized · forbidden · not-found · status-<code>
 *      slow-<ms> (delay before responding) · no-usage · tool (call the first tool)
 *      chunks-<n> · chunk-delay-<ms> · fail-after-<n> · stall-after-<n>   (streaming)
 *
 * 2. Fault rules set at runtime, for load tests and failover drills:
 *      POST /mock/faults   {"match":"gpt","status":503,"errorRate":1,"latencyMs":0,
 *                           "ttftMs":0,"failAfterChunks":5,"noUsage":false}
 *      GET /mock/faults · DELETE /mock/faults
 *    `match` is a substring of the model ("*" matches all); the first matching rule applies.
 *
 * GET /mock/requests lists recent requests (newest first, `aborted: true` if the client left
 * mid-stream); DELETE /mock/requests clears it.
 */

type RecordedRequest = {
  path: string;
  headers: Record<string, unknown>;
  body: unknown;
  aborted?: boolean;
  abortedAt?: number;
};

export type FaultRule = {
  match: string;
  status?: number;
  /** Probability (0-1) that `status` is returned; default 1. */
  errorRate?: number;
  latencyMs?: number;
  ttftMs?: number;
  failAfterChunks?: number;
  noUsage?: boolean;
};

type Behaviour = {
  errorStatus?: number;
  delayMs: number;
  chunks?: number;
  chunkDelayMs: number;
  failAfter?: number;
  stallAfter?: number;
  noUsage: boolean;
  tool: boolean;
};

type ChatMessage = { role: string; content?: unknown };
type ToolDef = { name?: string; function?: { name?: string } };

const NAMED_STATUS: Record<string, number> = {
  'rate-limit': 429,
  'server-error': 500,
  'bad-request': 400,
  unauthorized: 401,
  forbidden: 403,
  'not-found': 404,
};

const numberAfter = (model: string, label: string) => {
  const match = new RegExp(`${label}-(\\d+)`).exec(model);
  return match ? Number(match[1]) : undefined;
};

const estimateTokens = (text: string) => Math.max(1, Math.ceil(text.length / 4));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  const last = [...(messages as ChatMessage[])].reverse().find((m) => m?.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return (last.content as Array<{ type?: string; text?: string }>)
      .filter((p) => p?.type === 'text')
      .map((p) => p.text ?? '')
      .join(' ');
  }
  return '';
}

function behaviourFor(model: string, faults: FaultRule[], random: () => number): Behaviour {
  const named = Object.entries(NAMED_STATUS).find(([name]) => model.includes(name))?.[1];
  const behaviour: Behaviour = {
    ...((named ?? numberAfter(model, 'status'))
      ? { errorStatus: named ?? numberAfter(model, 'status')! }
      : {}),
    delayMs: numberAfter(model, 'slow') ?? 0,
    ...(numberAfter(model, 'chunks') !== undefined
      ? { chunks: numberAfter(model, 'chunks')! }
      : {}),
    chunkDelayMs: numberAfter(model, 'chunk-delay') ?? 2,
    ...(numberAfter(model, 'fail-after') !== undefined
      ? { failAfter: numberAfter(model, 'fail-after')! }
      : {}),
    ...(numberAfter(model, 'stall-after') !== undefined
      ? { stallAfter: numberAfter(model, 'stall-after')! }
      : {}),
    noUsage: model.includes('no-usage'),
    tool: model.includes('tool'),
  };
  const rule = faults.find((f) => f.match === '*' || model.includes(f.match));
  if (rule) {
    if (rule.status !== undefined && random() < (rule.errorRate ?? 1))
      behaviour.errorStatus = rule.status;
    if (rule.latencyMs !== undefined) behaviour.delayMs = rule.latencyMs;
    if (rule.ttftMs !== undefined) behaviour.delayMs = rule.ttftMs;
    if (rule.failAfterChunks !== undefined) behaviour.failAfter = rule.failAfterChunks;
    if (rule.noUsage) behaviour.noUsage = true;
  }
  return behaviour;
}

/** Text to stream: numbered tokens for `chunks-<n>`, else the echo reply split into words. */
const pieces = (b: Behaviour, reply: string) =>
  b.chunks !== undefined
    ? Array.from({ length: b.chunks }, (_, i) => `tok${i} `)
    : reply.split(/(?<= )/);

/**
 * Writes SSE frames, honouring the streaming failure modes. Returns once the stream ends, fails,
 * stalls, or the client goes away.
 */
async function writeStream(
  reply: FastifyReply,
  entry: RecordedRequest,
  b: Behaviour,
  frames: { start: string[]; body: string[]; end: string[] },
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
  for (const [i, frame] of frames.body.entries()) {
    if (closed) return;
    if (b.failAfter !== undefined && i >= b.failAfter) {
      res.destroy();
      return;
    }
    if (b.stallAfter !== undefined && i >= b.stallAfter) return; // idle until the client leaves
    res.write(frame);
    await sleep(b.chunkDelayMs);
  }
  if (closed) return;
  for (const frame of frames.end) res.write(frame);
  res.end();
}

export function buildApp(
  options: { logLevel?: string; historySize?: number; random?: () => number } = {},
): FastifyInstance {
  const app = Fastify({ logger: { level: options.logLevel ?? 'info' } });
  const history: RecordedRequest[] = [];
  let faults: FaultRule[] = [];
  let counter = 0;
  const random = options.random ?? Math.random;

  const record = (path: string, headers: Record<string, unknown>, body: unknown) => {
    const entry: RecordedRequest = { path, headers, body };
    history.unshift(entry);
    history.length = Math.min(history.length, options.historySize ?? 50);
    return entry;
  };

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/mock/requests', async () => history);
  app.delete('/mock/requests', async (_req, reply) => {
    history.length = 0;
    return reply.code(204).send();
  });

  app.get('/mock/faults', async () => faults);
  app.post('/mock/faults', async (request, reply) => {
    const rule = request.body as FaultRule;
    if (!rule || typeof rule.match !== 'string') {
      return reply.code(400).send({ error: 'a fault rule needs a "match" string' });
    }
    faults.push(rule);
    return reply.code(201).send(faults);
  });
  app.delete('/mock/faults', async (_req, reply) => {
    faults = [];
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- OpenAI chat completions
  app.post('/v1/chat/completions', async (request, reply) => {
    const body = (request.body ?? {}) as {
      model?: string;
      messages?: unknown;
      tools?: ToolDef[];
      stream?: boolean;
      stream_options?: { include_usage?: boolean };
    };
    const entry = record(request.url, request.headers, body);
    const model = body.model ?? 'mock';
    const b = behaviourFor(model, faults, random);
    if (b.delayMs) await sleep(b.delayMs);

    if (b.errorStatus) {
      const messages: Record<number, [string, string, string]> = {
        429: ['rate_limit_error', 'rate_limit_exceeded', 'Rate limit reached (mock)'],
        500: ['server_error', 'server_error', 'Upstream exploded (mock)'],
        400: ['invalid_request_error', 'invalid_value', "Invalid value for 'temperature' (mock)"],
        401: ['invalid_request_error', 'invalid_api_key', 'Incorrect API key (mock)'],
        403: ['invalid_request_error', 'forbidden', 'Not allowed (mock)'],
        404: ['invalid_request_error', 'model_not_found', 'The model does not exist (mock)'],
      };
      const [type, code, message] = messages[b.errorStatus] ?? [
        'server_error',
        'error',
        `HTTP ${b.errorStatus} (mock)`,
      ];
      if (b.errorStatus === 429) reply.header('retry-after', '1');
      return reply.code(b.errorStatus).send({ error: { message, type, code, param: null } });
    }

    counter += 1;
    const id = `chatcmpl-mock-${counter}`;
    const promptTokens = estimateTokens(JSON.stringify(body.messages ?? []));
    const toolName = b.tool
      ? (body.tools?.[0]?.function?.name ?? body.tools?.[0]?.name)
      : undefined;
    const content = `Mock reply to: ${lastUserText(body.messages)}`.trim();
    const toolArgs = JSON.stringify({ query: lastUserText(body.messages) });
    const usage = (completion: string) => ({
      prompt_tokens: promptTokens,
      completion_tokens: estimateTokens(completion),
      total_tokens: promptTokens + estimateTokens(completion),
    });

    if (body.stream) {
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const parts = toolName ? [toolArgs.slice(0, 8), toolArgs.slice(8)] : pieces(b, content);
      const emitted = parts.join('');
      await writeStream(reply, entry, b, {
        start: [
          chunk(
            toolName
              ? {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_mock_${counter}`,
                      type: 'function',
                      function: { name: toolName, arguments: '' },
                    },
                  ],
                }
              : { role: 'assistant', content: '' },
            null,
          ),
        ],
        body: parts.map((p) =>
          toolName
            ? chunk({ tool_calls: [{ index: 0, function: { arguments: p } }] }, null)
            : chunk({ content: p }, null),
        ),
        end: [
          chunk({}, toolName ? 'tool_calls' : 'stop'),
          ...(body.stream_options?.include_usage && !b.noUsage
            ? [
                `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model, choices: [], usage: usage(emitted) })}\n\n`,
              ]
            : []),
          'data: [DONE]\n\n',
        ],
      });
      return reply;
    }

    const message = toolName
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `call_mock_${counter}`,
              type: 'function',
              function: { name: toolName, arguments: toolArgs },
            },
          ],
        }
      : { role: 'assistant', content };
    return {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        { index: 0, message, finish_reason: toolName ? 'tool_calls' : 'stop', logprobs: null },
      ],
      ...(b.noUsage ? {} : { usage: usage(toolName ? toolArgs : content) }),
    };
  });

  // ---------------------------------------------------------------- Anthropic messages
  app.post('/v1/messages', async (request, reply) => {
    const body = (request.body ?? {}) as {
      model?: string;
      messages?: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
      tools?: ToolDef[];
      max_tokens?: number;
      stream?: boolean;
    };
    const entry = record(request.url, request.headers, body);
    const model = body.model ?? 'mock';
    const b = behaviourFor(model, faults, random);
    if (b.delayMs) await sleep(b.delayMs);

    const anthropicError = (status: number, type: string, message: string) =>
      reply.code(status).send({ type: 'error', error: { type, message } });
    if (b.errorStatus) {
      const errors: Record<number, [number, string, string]> = {
        429: [429, 'rate_limit_error', 'Rate limited (mock)'],
        500: [529, 'overloaded_error', 'Overloaded (mock)'],
        400: [400, 'invalid_request_error', 'Bad request (mock)'],
        401: [401, 'authentication_error', 'invalid x-api-key (mock)'],
        403: [403, 'permission_error', 'Not allowed (mock)'],
        404: [404, 'not_found_error', 'model not found (mock)'],
      };
      const [status, type, message] = errors[b.errorStatus] ?? [
        b.errorStatus,
        'api_error',
        `HTTP ${b.errorStatus} (mock)`,
      ];
      return anthropicError(status, type, message);
    }
    if (!body.max_tokens)
      return anthropicError(400, 'invalid_request_error', 'max_tokens: Field required');

    const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
    const userText = (lastUser?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join(' ');
    const toolName = b.tool
      ? (body.tools?.[0]?.name ?? body.tools?.[0]?.function?.name)
      : undefined;
    const inputTokens = estimateTokens(JSON.stringify(body.messages ?? []));
    counter += 1;

    if (body.stream) {
      const event = (type: string, data: object) =>
        `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      const toolJson = JSON.stringify({ query: userText });
      const parts = toolName
        ? [toolJson.slice(0, 8), toolJson.slice(8)]
        : pieces(b, `Mock reply to: ${userText}`.trim());
      await writeStream(reply, entry, b, {
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
          event('content_block_start', {
            index: 0,
            content_block: toolName
              ? { type: 'tool_use', id: `toolu_mock_${counter}`, name: toolName, input: {} }
              : { type: 'text', text: '' },
          }),
          event('ping', {}),
        ],
        body: parts.map((p) =>
          event('content_block_delta', {
            index: 0,
            delta: toolName
              ? { type: 'input_json_delta', partial_json: p }
              : { type: 'text_delta', text: p },
          }),
        ),
        end: [
          event('content_block_stop', { index: 0 }),
          event('message_delta', {
            delta: { stop_reason: toolName ? 'tool_use' : 'end_turn', stop_sequence: null },
            ...(b.noUsage ? {} : { usage: { output_tokens: estimateTokens(parts.join('')) } }),
          }),
          event('message_stop', {}),
        ],
      });
      return reply;
    }

    const content = toolName
      ? [
          {
            type: 'tool_use',
            id: `toolu_mock_${counter}`,
            name: toolName,
            input: { query: userText },
          },
        ]
      : [{ type: 'text', text: `Mock reply to: ${userText}`.trim() }];
    return {
      id: `msg_mock_${counter}`,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: toolName ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: estimateTokens(JSON.stringify(content)) },
    };
  });

  return app;
}
