import { chatCompletionRequestSchema, knownRequestFields } from '@gw/schema';
import type { FastifyPluginAsync } from 'fastify';
import type { ModelCatalog } from '../catalog/catalog.js';
import type { ResolvedCredential } from '../credentials/service.js';
import { GatewayError } from '../errors.js';
import { effectiveDeadlineMs, type DeadlineOptions } from '../execution/deadline.js';
import { ExecutionEngine, ExecutionFailure, type CandidateFailure } from '../execution/engine.js';
import type { ProviderError } from '../providers/errors.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { estimateTokens } from '../providers/openai-compatible.js';
import { planCandidates } from '../routing/planner.js';
import { buildUsageEvent, type UsageEventInput } from '../metering/event.js';
import { noopRecorder, type UsageRecorder } from '../metering/recorder.js';
import { sendStream, type StreamOptions, type StreamStatus } from './stream.js';

const streamStatus: Record<StreamStatus, UsageEventInput['status']> = {
  completed: 'success',
  partial: 'partial',
  client_cancelled: 'client_cancelled',
};

export interface CredentialSource {
  resolve(tenantId: string, provider: string): Promise<ResolvedCredential | null>;
}

export type ChatRouteDeps = {
  providers: ProviderRegistry;
  catalog?: ModelCatalog;
  credentials: CredentialSource;
  engine?: ExecutionEngine;
  deadline?: DeadlineOptions;
  stream?: StreamOptions;
  usage?: UsageRecorder;
};

/** Upstream failures as the client sees them. */
export function toGatewayError(err: ProviderError): GatewayError {
  const retryAfter: Record<string, string> = err.retryAfterSeconds
    ? { 'retry-after': String(err.retryAfterSeconds) }
    : {};
  switch (err.kind) {
    case 'invalid_request':
      return new GatewayError(400, 'invalid_request', 'provider_rejected_request', err.message);
    case 'rate_limited':
      return new GatewayError(
        429,
        'rate_limited',
        'provider_rate_limited',
        err.message,
        retryAfter,
      );
    case 'provider_timeout':
      return new GatewayError(504, 'provider_timeout', 'provider_timeout', err.message);
    case 'provider_auth':
      return new GatewayError(
        502,
        'provider_error',
        'provider_auth_failed',
        `${err.provider} rejected the configured credential`,
      );
    case 'provider_error':
      return new GatewayError(502, 'provider_error', 'provider_error', err.message);
  }
}

function describeIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.map(String).join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

const describeFailure = (f: CandidateFailure) =>
  `${f.candidate.id}: ${f.error.kind}${f.error.upstreamStatus ? ` (HTTP ${f.error.upstreamStatus})` : ''} after ${f.attempts} attempt${f.attempts === 1 ? '' : 's'}`;

/** Client-facing error for a failed execution, carrying the attempt count. */
export function failureToGatewayError(failure: ExecutionFailure, deadlineMs: number): GatewayError {
  const headers = { 'x-gateway-attempts': String(failure.attempts.length) };
  const withHeaders = (err: GatewayError) =>
    new GatewayError(err.status, err.type, err.code, err.message, { ...err.headers, ...headers });

  if (failure.terminal) return withHeaders(toGatewayError(failure.terminal));
  if (failure.deadlineExceeded) {
    const tried = failure.failures.map(describeFailure).join('; ');
    return new GatewayError(
      504,
      'provider_timeout',
      'deadline_exceeded',
      `Request deadline of ${deadlineMs}ms exceeded${tried ? `: ${tried}` : ''}`,
      headers,
    );
  }
  if (failure.failures.length === 1) return withHeaders(toGatewayError(failure.failures[0]!.error));
  return new GatewayError(
    502,
    'provider_error',
    'all_candidates_failed',
    `All ${failure.failures.length} candidates failed: ${failure.failures.map(describeFailure).join('; ')}`,
    headers,
  );
}

export function chatRoutes(deps: ChatRouteDeps): FastifyPluginAsync {
  const engine = deps.engine ?? new ExecutionEngine();
  const deadlineOptions = deps.deadline ?? { defaultMs: 60_000, maxMs: 300_000 };
  const streamOptions = deps.stream ?? { idleTimeoutMs: 30_000, heartbeatMs: 15_000 };
  const usage = deps.usage ?? noopRecorder;

  return async (scope) => {
    scope.post('/chat/completions', async (request, reply) => {
      const startedAt = new Date();
      const deadlineMs = effectiveDeadlineMs(
        request.headers['x-gateway-timeout-ms'],
        deadlineOptions,
      );
      const deadlineAt = Date.now() + deadlineMs;
      reply.header('x-gateway-deadline-ms', String(deadlineMs));

      const parsed = chatCompletionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new GatewayError(
          400,
          'invalid_request',
          'invalid_request_body',
          parsed.error.issues.slice(0, 5).map(describeIssue).join('; '),
        );
      }
      const body = parsed.data;
      if (request.body && typeof request.body === 'object') {
        const ignored = Object.keys(request.body).filter((k) => !knownRequestFields.has(k));
        if (ignored.length) request.log.debug({ ignored }, 'ignoring unknown request fields');
      }
      // Fires when the client goes away before the response has been fully written.
      const client = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) client.abort(new Error('client disconnected'));
      });

      const auth = request.auth!;
      const plan = await planCandidates({
        request: body,
        registry: deps.providers,
        ...(deps.catalog ? { catalog: deps.catalog } : {}),
        credentials: deps.credentials,
        tenantId: auth.tenantId,
        tenantSettings: auth.tenantSettings,
      });
      if (plan.skipped.length)
        request.log.info({ skipped: plan.skipped }, 'skipped ineligible candidates');

      // Every request that reaches a provider is metered, whatever its outcome.
      const meter = (
        outcome: Pick<UsageEventInput, 'status' | 'model' | 'attempts' | 'usage' | 'ttftMs'>,
      ) => {
        try {
          usage.record(
            buildUsageEvent({
              ...outcome,
              requestId: request.id,
              tenantId: auth.tenantId,
              apiKeyId: auth.keyId,
              requestedModel: body.model,
              firstCandidateId: plan.candidates[0]!.id,
              startedAt,
              finishedAt: new Date(),
              routeReason: plan.virtual
                ? `policy:${body.model}`
                : body.gateway?.fallback
                  ? 'concrete+fallback'
                  : 'concrete',
            }),
          );
        } catch (err) {
          request.log.error({ err }, 'failed to build usage event');
        }
      };

      try {
        if (body.stream) {
          // Fallback is possible only until the first event; after that the stream is committed.
          const stream = await engine.executeStream(
            body,
            plan.candidates,
            deadlineAt,
            client.signal,
          );
          const ttftMs = Date.now() - startedAt.getTime();
          const outcome = await sendStream({
            request,
            reply,
            stream,
            headers: {
              'x-gateway-provider': stream.served.provider,
              'x-gateway-model': stream.served.id,
              'x-gateway-attempts': String(stream.attempts.length),
              'x-gateway-deadline-ms': String(deadlineMs),
            },
            includeUsage: body.stream_options?.include_usage === true,
            promptEstimate: estimateTokens(JSON.stringify(body.messages)),
            clientSignal: client.signal,
            options: streamOptions,
          });
          request.log.info(
            {
              status: outcome.status,
              chunks: outcome.chunks,
              usage: outcome.usage,
              attempts: stream.attempts,
            },
            'stream finished',
          );
          meter({
            status: streamStatus[outcome.status],
            model: stream.served,
            attempts: stream.attempts,
            usage: outcome.usage,
            ttftMs,
          });
          return reply;
        }

        const { result, served, attempts } = await engine.execute(
          body,
          plan.candidates,
          deadlineAt,
          client.signal,
        );
        if (attempts.length > 1)
          request.log.info({ attempts }, 'request needed retries or fallback');
        meter({ status: 'success', model: served, attempts, usage: result.usage, ttftMs: null });
        reply.headers({
          'x-gateway-provider': served.provider,
          'x-gateway-model': served.id,
          'x-gateway-attempts': String(attempts.length),
          ...(result.emulated?.length ? { 'x-gateway-emulated': result.emulated.join(',') } : {}),
        });
        return { ...result.response, model: served.id };
      } catch (err) {
        if (err instanceof ExecutionFailure) {
          request.log.warn({ attempts: err.attempts }, 'all attempts failed');
          const lastTried = err.failures.at(-1)?.candidate ?? plan.candidates[0]!;
          // Failed attempts got no upstream response worth billing, so no usage is recorded.
          meter({
            status: 'error',
            model: lastTried,
            attempts: err.attempts,
            usage: undefined,
            ttftMs: null,
          });
          throw failureToGatewayError(err, deadlineMs);
        }
        throw err;
      }
    });
  };
}
