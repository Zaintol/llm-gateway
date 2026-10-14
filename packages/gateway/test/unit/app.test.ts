import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { DependencyCheck } from '../../src/readiness.js';

const ok: DependencyCheck = async () => {};
const down: DependencyCheck = async () => {
  throw new Error('ECONNREFUSED');
};
const hang: DependencyCheck = () => new Promise(() => {});

let app: FastifyInstance;
afterEach(() => app?.close());

function make(checks: Record<string, DependencyCheck>) {
  app = buildApp({ logLevel: 'silent', readinessChecks: checks, readinessTimeoutMs: 50 });
  return app;
}

describe('GET /healthz', () => {
  it('returns 200 even when dependencies are down', async () => {
    const res = await make({ postgres: down, redis: down }).inject('/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /readyz', () => {
  it('returns 200 when every dependency is reachable', async () => {
    const res = await make({ postgres: ok, redis: ok }).inject('/readyz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      checks: { postgres: 'ok', redis: 'ok' },
      failing: [],
    });
  });

  it('returns 503 naming redis when redis is unreachable', async () => {
    const res = await make({ postgres: ok, redis: down }).inject('/readyz');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      status: 'unavailable',
      checks: { postgres: 'ok', redis: 'error' },
      failing: ['redis'],
    });
  });

  it('treats a dependency that does not answer within the timeout as failing', async () => {
    const res = await make({ postgres: hang, redis: ok }).inject('/readyz');
    expect(res.statusCode).toBe(503);
    expect(res.json().failing).toEqual(['postgres']);
  });
});

describe('request ids', () => {
  it('are generated as unique ids when the client sends none', async () => {
    const a = await make({}).inject('/healthz');
    const b = await app.inject('/healthz');
    expect(a.headers['x-request-id']).toMatch(/^req_[0-9a-f-]{36}$/);
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });
});

describe('unknown routes', () => {
  it('return the OpenAI error envelope and echo the request id', async () => {
    const res = await make({}).inject({ url: '/v1/nope', headers: { 'x-request-id': 'req_123' } });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-request-id']).toBe('req_123');
    expect(res.json()).toEqual({
      error: {
        type: 'invalid_request_error',
        code: 'not_found',
        message: 'Route GET /v1/nope not found',
      },
    });
  });
});
