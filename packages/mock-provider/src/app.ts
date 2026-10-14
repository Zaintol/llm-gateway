import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Fake upstream for tests, load tests and the public demo. Phase 0 ships only the skeleton;
 * provider-shaped endpoints and fault injection arrive with GW-10.1.
 */
export function buildApp(options: { logLevel?: string } = {}): FastifyInstance {
  const app = Fastify({ logger: { level: options.logLevel ?? 'info' } });
  app.get('/healthz', async () => ({ status: 'ok' }));
  return app;
}
