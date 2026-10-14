import { randomUUID } from 'node:crypto';
import Fastify, {
  LogController,
  type FastifyError,
  type FastifyInstance,
  type FastifyPluginAsync,
} from 'fastify';
import { errorEnvelope } from '@gw/schema';
import type { DestinationStream } from 'pino';
import { guardAdminPlane, requireApiKey, type DataPlaneAuth } from './auth/plugin.js';
import { GatewayError } from './errors.js';
import { loggerOptions } from './observability/logging.js';
import { registry } from './observability/metrics.js';
import { SpanStatusCode, context, startRequestSpan, type Span } from './observability/tracing.js';
import { checkReadiness, type DependencyCheck } from './readiness.js';

/** Fastify's own client errors, renamed into the gateway's vocabulary. */
const fastifyErrorCodes: Record<string, string> = {
  FST_ERR_CTP_BODY_TOO_LARGE: 'request_too_large',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'unsupported_media_type',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'invalid_json',
  FST_ERR_CTP_INVALID_JSON_BODY: 'invalid_json',
};

/** Per-request facts gathered along the pipeline for the access log line and the root span. */
export type RequestTelemetry = {
  span: Span | null;
  traceId: string | undefined;
  servedModel?: string;
  attempts?: number;
  costMicros?: bigint;
};

declare module 'fastify' {
  interface FastifyRequest {
    telemetry: RequestTelemetry;
  }
}

/** Probes and scrapes run every few seconds; tracing and logging them would drown real traffic. */
const QUIET_ROUTES = new Set(['/healthz', '/readyz', '/metrics']);

export type AppOptions = {
  logLevel?: string;
  /** Log destination; stdout when unset (tests capture lines here). */
  logStream?: DestinationStream;
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
    logger: {
      ...loggerOptions(options.logLevel ?? 'info'),
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
    // One access line per request is written in onResponse instead of Fastify's two.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: options.trustProxy ?? false,
    bodyLimit: options.bodyLimitBytes ?? 1_048_576,
    requestIdHeader: 'x-request-id',
    genReqId: () => `req_${randomUUID()}`,
  });

  app.decorateRequest('telemetry', null as unknown as RequestTelemetry);

  // Root span per request, continuing any incoming W3C traceparent. Calling `done` inside
  // context.with() runs the rest of the request lifecycle within the span's async context.
  app.addHook('onRequest', (request, _reply, done) => {
    const route = request.routeOptions.url ?? request.url;
    if (QUIET_ROUTES.has(route)) {
      request.telemetry = { span: null, traceId: undefined };
      return done();
    }
    const { span, ctx } = startRequestSpan(`${request.method} ${route}`, request.headers, {
      'http.request.method': request.method,
      'http.route': route,
      'url.path': request.url.split('?')[0],
      'gateway.request_id': request.id,
    });
    const traceId = span.spanContext().traceId;
    request.telemetry = { span, traceId };
    context.with(ctx, done);
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    if (request.telemetry?.traceId) reply.header('x-trace-id', request.telemetry.traceId);
  });

  app.addHook('onResponse', async (request, reply) => {
    const t = request.telemetry;
    if (!t?.span) return;
    const status = reply.statusCode;
    t.span.setAttributes({
      'http.response.status_code': status,
      ...(t.servedModel ? { 'gateway.served_model': t.servedModel } : {}),
      ...(t.attempts !== undefined ? { 'gateway.attempts': t.attempts } : {}),
      ...(t.costMicros !== undefined
        ? { 'gateway.cost_usd': Number(t.costMicros) / 1_000_000 }
        : {}),
    });
    if (status >= 500) t.span.setStatus({ code: SpanStatusCode.ERROR });
    t.span.end();
    request.log.info(
      {
        request_id: request.id,
        trace_id: t.traceId,
        tenant_id: request.auth?.tenantId,
        key_prefix: request.auth?.keyPrefix,
        method: request.method,
        route: request.routeOptions.url ?? request.url,
        status,
        served_model: t.servedModel,
        attempts: t.attempts,
        latency_ms: Math.round(reply.elapsedTime),
        cost_usd: t.costMicros === undefined ? undefined : Number(t.costMicros) / 1_000_000,
      },
      'request completed',
    );
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
