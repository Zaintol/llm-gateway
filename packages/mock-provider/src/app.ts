import Fastify, { type FastifyInstance } from 'fastify';

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
 * GW-10.1 extends this with Anthropic/Gemini shapes, streaming and runtime fault injection.
 */

type RecordedRequest = { path: string; headers: Record<string, unknown>; body: unknown };

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
