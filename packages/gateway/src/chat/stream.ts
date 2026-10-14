import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { GatewayError } from '../errors.js';
import type { StreamSuccess } from '../execution/engine.js';
import { ProviderError } from '../providers/errors.js';
import { estimateTokens } from '../providers/openai-compatible.js';
import type { ProviderUsage, StreamEvent } from '../providers/types.js';

export type StreamStatus = 'completed' | 'partial' | 'client_cancelled';

export type StreamOutcome = {
  status: StreamStatus;
  chunks: number;
  /** Provider-reported usage when the stream completed; an estimate otherwise. */
  usage: ProviderUsage;
};

export type StreamOptions = { idleTimeoutMs: number; heartbeatMs: number };

class IdleTimeout extends Error {}

/**
 * Writes a committed stream to the client as OpenAI `chat.completion.chunk` server-sent events.
 * Failures after the first byte cannot fall back: they become a final error event, then [DONE].
 */
export async function sendStream(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  stream: StreamSuccess;
  headers: Record<string, string>;
  includeUsage: boolean;
  promptEstimate: number;
  clientSignal: AbortSignal;
  options: StreamOptions;
  /** Called with the outcome just before the response ends. */
  beforeEnd?: (outcome: StreamOutcome) => void;
}): Promise<StreamOutcome> {
  const { reply, stream, includeUsage, clientSignal, options } = input;
  const raw = reply.raw;
  reply.hijack();
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-request-id': input.request.id,
    ...input.headers,
  });

  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = stream.served.id;
  const open = () => !raw.writableEnded && !raw.destroyed;
  const send = (payload: unknown) => {
    if (open()) raw.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  let chunks = 0;
  let roleSent = false;
  let output = '';
  let usage: ProviderUsage | undefined;
  const emit = (event: StreamEvent) => {
    if (event.type === 'usage') {
      usage = event.usage;
      return;
    }
    const delta = roleSent ? event.delta : { role: 'assistant' as const, ...event.delta };
    roleSent = true;
    output +=
      (event.delta.content ?? '') +
      (event.delta.tool_calls ? JSON.stringify(event.delta.tool_calls) : '');
    send({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: event.finishReason, logprobs: null }],
      ...(includeUsage ? { usage: null } : {}),
    });
    chunks++;
  };

  // Comment lines keep proxies from closing a connection while the model is thinking.
  const heartbeat = setInterval(() => open() && raw.write(': ping\n\n'), options.heartbeatMs);
  const abortUpstream = () => stream.abort();
  clientSignal.addEventListener('abort', abortUpstream, { once: true });

  let status: StreamStatus = 'completed';
  try {
    emit(stream.first);
    for (;;) {
      if (clientSignal.aborted) throw clientSignal.reason;
      let idleTimer: NodeJS.Timeout | undefined;
      const idle = new Promise<never>((_, reject) => {
        idleTimer = setTimeout(() => {
          stream.abort();
          reject(new IdleTimeout());
        }, options.idleTimeoutMs);
      });
      try {
        const next = await Promise.race([stream.rest.next(), idle]);
        if (next.done) break;
        emit(next.value);
      } finally {
        clearTimeout(idleTimer);
      }
    }
  } catch (err) {
    if (clientSignal.aborted) {
      status = 'client_cancelled';
    } else {
      status = 'partial';
      const failure =
        err instanceof IdleTimeout
          ? new GatewayError(
              504,
              'provider_timeout',
              'stream_idle_timeout',
              `${stream.served.provider} sent nothing for ${options.idleTimeoutMs}ms`,
            )
          : err instanceof ProviderError
            ? new GatewayError(502, 'provider_error', 'stream_interrupted', err.message)
            : new GatewayError(500, 'internal', 'internal_error', 'Internal server error');
      if (!(err instanceof IdleTimeout) && !(err instanceof ProviderError)) {
        input.request.log.error({ err }, 'stream failed');
      }
      send({ error: { type: failure.type, code: failure.code, message: failure.message } });
    }
  } finally {
    clearInterval(heartbeat);
    clientSignal.removeEventListener('abort', abortUpstream);
  }

  const finalUsage: ProviderUsage =
    status === 'completed' && usage
      ? usage
      : {
          inputTokens: input.promptEstimate,
          outputTokens: estimateTokens(output),
          cachedInputTokens: 0,
          source: 'estimated',
        };
  if (status === 'completed' && includeUsage) {
    send({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [],
      usage: {
        prompt_tokens: finalUsage.inputTokens,
        completion_tokens: finalUsage.outputTokens,
        total_tokens: finalUsage.inputTokens + finalUsage.outputTokens,
      },
    });
  }
  const outcome = { status, chunks, usage: finalUsage };
  input.beforeEnd?.(outcome);
  if (open()) raw.end('data: [DONE]\n\n');
  return outcome;
}
