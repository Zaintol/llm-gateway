import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { buildApp } from '../../src/app.js';
import { fakeAuth } from '../support/fakes.js';

/** Stand-in data-plane route; the real chat endpoint arrives in GW-2.1. */
const echoTenant: FastifyPluginAsync = async (scope) => {
  scope.post('/chat/completions', async (request) => ({ tenantId: request.auth?.tenantId }));
};

let app: FastifyInstance;
afterEach(() => app?.close());

function make() {
  const fakes = fakeAuth();
  app = buildApp({
    logLevel: 'silent',
    readinessChecks: {},
    readinessTimeoutMs: 50,
    auth: fakes.auth,
    dataPlaneRoutes: [echoTenant],
  });
  return { app, ...fakes };
}

const post = (app: FastifyInstance, authorization?: string, ip = '10.0.0.1') =>
  app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    remoteAddress: ip,
    headers: authorization ? { authorization } : {},
  });

describe('data plane authentication', () => {
  it('lets a valid key through with its tenant attached', async () => {
    const { app, store } = make();
    const { key } = store.add({ tenantId: 'tenant_42' });
    const res = await post(app, `Bearer ${key}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId: 'tenant_42' });
  });

  it('returns 401 authentication when the Authorization header is missing', async () => {
    const { app } = make();
    const res = await post(app);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({ type: 'authentication', code: 'missing_api_key' });
  });

  it('returns 429 on the 21st failed attempt from one IP, even with a valid key', async () => {
    const { app, store } = make();
    const { key } = store.add();
    for (let i = 0; i < 20; i++) {
      expect((await post(app, 'Bearer gw_live_nope', '10.0.0.9')).statusCode).toBe(401);
    }
    const res = await post(app, `Bearer ${key}`, '10.0.0.9');
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('60');
    expect(res.json().error.code).toBe('too_many_auth_failures');
  });

  it('does not block other IPs when one IP is blocked', async () => {
    const { app, store } = make();
    const { key } = store.add();
    for (let i = 0; i < 20; i++) await post(app, 'Bearer gw_live_nope', '10.0.0.9');
    expect((await post(app, `Bearer ${key}`, '10.0.0.10')).statusCode).toBe(200);
  });
});

describe('admin plane guard', () => {
  it('returns 403 for a valid data-plane key', async () => {
    const { app, store } = make();
    const { key } = store.add();
    const res = await app.inject({
      url: '/admin/v1/tenants',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({
      type: 'permission',
      code: 'data_plane_key_not_allowed',
    });
  });

  it('returns 401 without credentials', async () => {
    const { app } = make();
    const res = await app.inject({ url: '/admin/v1/tenants' });
    expect(res.statusCode).toBe(401);
  });
});
