import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { errorEnvelope } from '@gw/schema';
import { guardAdminPlane, requireApiKey, type DataPlaneAuth } from './auth/plugin.js';
import { GatewayError } from './errors.js';
import { registry } from './observability/metrics.js';
import { checkReadiness, type DependencyCheck } from './readiness.js';

/** Fastify's own client errors, renamed into the gateway's vocabulary. */
const fastifyErrorCodes: Record<string, string> = {
  FST_ERR_CTP_BODY_TOO_LARGE: 'request_too_large',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'unsupported_media_type',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'invalid_json',
  FST_ERR_CTP_INVALID_JSON_BODY: 'invalid_json',
};

export type AppOptions = {
  logLevel?: string;
  /** Trust X-Forwarded-For from the platform proxy (needed for per-IP limits behind Fly). */
  trustProxy?: boolean;
  bodyLimitBytes?: number;
  readinessChecks: Record<string, DependencyCheck>;
  readinessTimeoutMs: number;
  auth: DataPlaneAuth;
  /** When set, GET /metrics requires `Authorization: Bearer <metricsToken>`. */
  metricsToken?: string;
  /** Routes mounted under /v1, behind API key authentication. */
  dataPlaneRoutes?: FastifyPluginAsync[];
};

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: options.logLevel ?? 'info' },
    trustProxy: options.trustProxy ?? false,
    bodyLimit: options.bodyLimitBytes ?? 1_048_576,
    requestIdHeader: 'x-request-id',
    genReqId: () => `req_${randomUUID()}`,
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // Liveness: the process is up and the event loop is serving requests.
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Readiness: every backing dependency the gateway needs is reachable.
  app.get('/readyz', async (_request, reply) => {
    const report = await checkReadiness(options.readinessChecks, options.readinessTimeoutMs);
    const failing = Object.entries(report.checks)
      .filter(([, status]) => status === 'error')
      .map(([name]) => name);
    if (!report.ready) {
      app.log.warn({ failing }, 'readiness check failed');
    }
    return reply
      .code(report.ready ? 200 : 503)
      .send({ status: report.ready ? 'ok' : 'unavailable', checks: report.checks, failing });
  });

  // Prometheus scrape endpoint. Lock it down with METRICS_TOKEN when the port is public.
  app.get('/metrics', async (request, reply) => {
    if (
      options.metricsToken &&
      request.headers.authorization !== `Bearer ${options.metricsToken}`
    ) {
      throw new GatewayError(
        401,
        'authentication',
        'metrics_token_required',
        'Metrics token required',
      );
    }
    return reply.type(registry.contentType).send(await registry.metrics());
  });

  app.register(
    async (dataPlane) => {
      requireApiKey(dataPlane, options.auth);
      for (const routes of options.dataPlaneRoutes ?? []) await dataPlane.register(routes);
    },
    { prefix: '/v1' },
  );

  app.register(
    async (adminPlane) => {
      guardAdminPlane(adminPlane);
      // Admin routes arrive with GW-9.1. Unknown admin paths still pass through the guard.
      adminPlane.all('/*', async () => {
        throw new GatewayError(404, 'not_found', 'not_found', 'Not found');
      });
    },
    { prefix: '/admin/v1' },
  );

  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send(
        errorEnvelope('not_found', 'not_found', `Route ${request.method} ${request.url} not found`),
      ),
  );

  app.setErrorHandler<FastifyError | GatewayError>((error, request, reply) => {
    if (error instanceof GatewayError) {
      return reply
        .code(error.status)
        .headers(error.headers)
        .send(errorEnvelope(error.type, error.code, error.message));
    }
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
      return reply
        .code(500)
        .send(errorEnvelope('internal', 'internal_error', 'Internal server error'));
    }
    const code = (error.code && fastifyErrorCodes[error.code]) ?? error.code ?? 'bad_request';
    return reply.code(status).send(errorEnvelope('invalid_request', code, error.message));
  });

  return app;
}
