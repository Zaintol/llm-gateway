import { chatCompletionRequestSchema, knownRequestFields } from '@gw/schema';
import type { FastifyPluginAsync } from 'fastify';
import type { ResolvedCredential } from '../credentials/service.js';
import { GatewayError } from '../errors.js';
import { ProviderError } from '../providers/errors.js';
import type { ProviderRegistry } from '../providers/registry.js';

export interface CredentialSource {
  resolve(tenantId: string, provider: string): Promise<ResolvedCredential | null>;
}

export type ChatRouteDeps = {
  providers: ProviderRegistry;
  credentials: CredentialSource;
  /** Overall deadline for the upstream call. Per-attempt timeouts and retries arrive in GW-3.1. */
  providerTimeoutMs: number;
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

export function chatRoutes(deps: ChatRouteDeps): FastifyPluginAsync {
  return async (scope) => {
    scope.post('/chat/completions', async (request, reply) => {
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
      if (body.stream) {
        // Streaming lands in GW-2.6.
        throw new GatewayError(
          400,
          'invalid_request',
          'stream_not_supported',
          'stream: true is not supported yet',
        );
      }

      const model = deps.providers.resolve(body.model);
      const auth = request.auth!;
      const credential = await deps.credentials.resolve(auth.tenantId, model.provider);
      if (model.adapter.requiresCredential && !credential) {
        throw new GatewayError(
          400,
          'no_eligible_model',
          'provider_not_configured',
          `No ${model.provider} credential is configured for this tenant`,
        );
      }

      try {
        const result = await model.adapter.complete(body, {
          upstreamModel: model.upstreamModel,
          credential,
          signal: AbortSignal.timeout(deps.providerTimeoutMs),
          ...(model.model ? { maxOutputTokens: model.model.maxOutputTokens } : {}),
        });
        reply.headers({
          'x-gateway-provider': model.provider,
          'x-gateway-model': model.id,
          'x-gateway-attempts': '1',
          ...(result.emulated?.length ? { 'x-gateway-emulated': result.emulated.join(',') } : {}),
        });
        return result.response;
      } catch (err) {
        if (err instanceof ProviderError) {
          request.log.warn(
            { provider: err.provider, kind: err.kind, upstreamStatus: err.upstreamStatus },
            'provider call failed',
          );
          throw toGatewayError(err);
        }
        throw err;
      }
    });
  };
}
