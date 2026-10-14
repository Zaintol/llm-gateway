import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { StaticCatalog, type ModelCatalog } from '../../src/catalog/catalog.js';
import { modelsRoutes } from '../../src/catalog/route.js';
import { chatRoutes } from '../../src/chat/route.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import {
  FakeAdapter,
  StaticCredentials,
  cannedResult,
  catalogModel,
  fakeAuth,
} from '../support/fakes.js';

let app: FastifyInstance;
afterEach(() => app?.close());

const catalog = new StaticCatalog([
  catalogModel(),
  catalogModel({
    id: 'mock/smart',
    upstreamModel: 'smart',
    maxOutputTokens: 8192,
    qualityTier: 3,
    capabilities: { tools: true, vision: true, jsonMode: true, streaming: true },
  }),
  catalogModel({ id: 'mock/retired', upstreamModel: 'retired', enabled: false }),
  catalogModel({ id: 'anthropic/claude-x', provider: 'anthropic', upstreamModel: 'claude-x' }),
]);

function make(modelCatalog: ModelCatalog = catalog) {
  const adapter = new FakeAdapter('mock', (req) => cannedResult(req.model));
  const providers = new ProviderRegistry([adapter], modelCatalog);
  const fakes = fakeAuth();
  const { key } = fakes.store.add();
  app = buildApp({
    logLevel: 'silent',
    readinessChecks: {},
    readinessTimeoutMs: 50,
    auth: fakes.auth,
    dataPlaneRoutes: [
      modelsRoutes({ catalog: modelCatalog, providers }),
      chatRoutes({ providers, credentials: new StaticCredentials(), providerTimeoutMs: 1000 }),
    ],
  });
  const headers = { authorization: `Bearer ${key}` };
  const chat = (model: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: { model, messages: [{ role: 'user', content: 'hi' }] },
    });
  return { adapter, headers, chat };
}

describe('GET /v1/models', () => {
  it('lists only enabled models of registered providers with capabilities and pricing', async () => {
    const { headers } = make();
    const res = await app.inject({ url: '/v1/models', headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('list');
    expect(body.data.map((m: { id: string }) => m.id)).toEqual(['mock/fast', 'mock/smart']);
    expect(body.data[1]).toMatchObject({
      object: 'model',
      owned_by: 'mock',
      gateway: {
        context_window: 32000,
        max_output_tokens: 8192,
        capabilities: { tools: true, vision: true, json_mode: true, streaming: true },
        quality_tier: 3,
        pricing: { currency: 'USD', input_per_mtok: 0.05, output_per_mtok: 0.2 },
      },
    });
  });

  it('requires authentication', async () => {
    make();
    expect((await app.inject({ url: '/v1/models' })).statusCode).toBe(401);
  });

  it('returns 503 until the catalog has loaded', async () => {
    const { headers } = make({
      ready: false,
      getModel: () => undefined,
      listModels: () => [],
      getPolicy: () => undefined,
    });
    expect((await app.inject({ url: '/v1/models', headers })).statusCode).toBe(503);
  });
});

describe('chat completions with a catalog', () => {
  it('passes the catalog upstream name and output limit to the adapter', async () => {
    const { chat, adapter } = make();
    expect((await chat('mock/smart')).statusCode).toBe(200);
    expect(adapter.calls[0]!.call).toMatchObject({ upstreamModel: 'smart', maxOutputTokens: 8192 });
  });

  it('returns 400 no_eligible_model for a disabled model', async () => {
    const { chat, adapter } = make();
    const res = await chat('mock/retired');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ type: 'no_eligible_model', code: 'model_disabled' });
    expect(adapter.calls).toHaveLength(0);
  });

  it('returns 400 no_eligible_model for a model outside the catalog', async () => {
    const { chat } = make();
    expect((await chat('mock/anything')).json().error.code).toBe('model_not_found');
  });

  it('returns 400 when the model provider is not configured on this gateway', async () => {
    const { chat } = make();
    expect((await chat('anthropic/claude-x')).json().error.code).toBe('provider_not_available');
  });
});
