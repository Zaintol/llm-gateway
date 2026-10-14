import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { errorEnvelope } from '@gw/schema';
import { checkReadiness, type DependencyCheck } from './readiness.js';

export type AppOptions = {
  logLevel?: string;
  readinessChecks: Record<string, DependencyCheck>;
  readinessTimeoutMs: number;
};

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: { level: options.logLevel ?? 'info' },
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

  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send(
        errorEnvelope(
          'invalid_request_error',
          'not_found',
          `Route ${request.method} ${request.url} not found`,
        ),
      ),
  );

  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, 'unhandled error');
    return reply
      .code(status)
      .send(
        errorEnvelope(
          status >= 500 ? 'api_error' : 'invalid_request_error',
          error.code ?? (status >= 500 ? 'internal_error' : 'bad_request'),
          status >= 500 ? 'Internal server error' : error.message,
        ),
      );
  });

  return app;
}
