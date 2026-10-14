import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { StaticCatalog, type CatalogModel } from '../../src/catalog/catalog.js';
import { chatRoutes } from '../../src/chat/route.js';
import { ExecutionEngine } from '../../src/execution/engine.js';
import { ProviderError } from '../../src/providers/errors.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import {
  FakeAdapter,
  StaticCredentials,
  cannedResult,
  catalogModel,
  fakeAuth,
} from '../support/fakes.js';

const priced = (
  id: string,
  inputUsd: number,
  outputUsd: number,
  extra: Partial<CatalogModel> = {},
) => {
  const price = {
    id: `price-${id}`,
    effectiveFrom: new Date('2020-01-01T00:00:00Z'),
    effectiveTo: null,
    inputPerMtokMicros: BigInt(Math.round(inputUsd * 1e6)),
    outputPerMtokMicros: BigInt(Math.round(outputUsd * 1e6)),
    cachedInputPerMtokMicros: null,
  };
  const provider = id.split('/')[0]!;
  return catalogModel({
    id,
    provider,
    upstreamModel: id.split('/')[1]!,
    contextWindow: 128_000,
    capabilities: { tools: true, vision: false, jsonMode: true, streaming: true },
    price,
    prices: [price],
    ...extra,
  });
};

const catalog = new StaticCatalog(
  [
    priced('pa/premium', 1, 4, { qualityTier: 3, latencyTier: 'standard' }),
    priced('pb/budget', 0.1, 0.4, { qualityTier: 1 }),
    priced('pc/mid', 0.5, 2, { qualityTier: 2 }),
    priced('pd/notools', 0.01, 0.01, {
      capabilities: { tools: false, vision: false, jsonMode: true, streaming: true },
    }),
    priced('pe/keyed', 0.001, 0.001),
    priced('pa/failure-demo', 0.0001, 0.0001, { routable: false }),
    priced('pf/unconfigured', 0.0001, 0.0001),
  ],
  [
    {
      id: 'auto',
      description: '',
      requirements: {},
      fallbackChain: ['pa/premium', 'pb/budget', 'pc/mid'],
      enabled: true,
    },
    {
      id: 'gw/cheap-fast',
      description: '',
      requirements: { latency_tier: 'fast' },
      fallbackChain: ['pc/mid', 'pb/budget'],
      enabled: true,
    },
    {
      id: 'gw/best-quality',
      description: '',
      requirements: { min_quality_tier: 3 },
      fallbackChain: ['pa/premium'],
      enabled: true,
    },
  ],
);

let app: FastifyInstance;
afterEach(() => app?.close());

function make(
  options: {
    costAware?: boolean;
    failing?: string[];
    tenantSettings?: Record<string, unknown>;
  } = {},
) {
  const adapters = ['pa', 'pb', 'pc', 'pd'].map(
    (p) =>
      new FakeAdapter(p, (req) => {
        if (options.failing?.includes(p))
          throw new ProviderError('provider_error', p, `${p} is down`);
        return cannedResult(req.model, `from ${p}`);
      }),
  );
  // pe needs a credential the tenant does not have, so the router must exclude it.
  adapters.push(new FakeAdapter('pe', (req) => cannedResult(req.model), true));
  // pf has no endpoint configured (like local models without LOCAL_MODELS_BASE_URL).
  const unconfigured = new FakeAdapter('pf', (req) => cannedResult(req.model));
  unconfigured.isConfigured = () => false;
  adapters.push(unconfigured);
  const fakes = fakeAuth();
  const { key } = fakes.store.add({ tenantSettings: options.tenantSettings ?? {} });
  app = buildApp({
    logLevel: 'silent',
    readinessChecks: {},
    readinessTimeoutMs: 50,
    auth: fakes.auth,
    dataPlaneRoutes: [
      chatRoutes({
        providers: new ProviderRegistry(adapters, catalog),
        catalog,
        credentials: new StaticCredentials(),
        engine: new ExecutionEngine({ sleep: async () => {}, maxRetries: 0 }),
        flags: { ff_cost_aware_routing: options.costAware ?? true },
      }),
    ],
  });
  return (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}` },
      payload: { messages: [{ role: 'user', content: 'hi' }], ...payload },
    });
}

describe('cost-aware router (GW-6.3)', () => {
  it('serves auto from the cheapest eligible model and names the next two as fallbacks', async () => {
    const res = await make()({
      model: 'auto',
      tools: [{ type: 'function', function: { name: 'f' } }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-gateway-model']).toBe('pb/budget');
    expect(res.headers['x-gateway-route-reason']).toBe(
      'cost-aware: pb/budget is the cheapest of 3 eligible; fallbacks pc/mid, pa/premium; 3 excluded',
    );
  });

  it('returns 400 no_eligible_model when no model fits under max_cost_usd', async () => {
    const res = await make()({
      model: 'auto',
      // Even the cheapest model (0.01 USD/Mtok) has a worst case of 0.001 USD at 100k tokens.
      max_tokens: 100_000,
      gateway: { max_cost_usd: 0.0001 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe('no_eligible_model');
    expect(res.json().error.message).toMatch(/worst case \$[\d.]+ > max_cost_usd/);
  });

  it('keeps a model whose worst case fits under max_cost_usd', async () => {
    const res = await make()({ model: 'auto', max_tokens: 100, gateway: { max_cost_usd: 0.001 } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-gateway-model']).toBe('pd/notools');
  });

  it('moves to the next cheapest model when the cheapest provider fails', async () => {
    const res = await make({ failing: ['pd'] })({ model: 'auto' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-gateway-model']).toBe('pb/budget');
  });

  it('uses the static policy chain when ff_cost_aware_routing is off', async () => {
    const res = await make({ costAware: false })({ model: 'gw/cheap-fast' });
    expect(res.headers['x-gateway-model']).toBe('pc/mid');
    expect(res.headers['x-gateway-route-reason']).toBe('static chain of gw/cheap-fast');
  });

  it('honours a per-tenant override of the flag', async () => {
    const res = await make({
      costAware: true,
      tenantSettings: { flags: { ff_cost_aware_routing: false } },
    })({ model: 'auto' });
    expect(res.headers['x-gateway-model']).toBe('pa/premium');
  });

  it('never substitutes a cheaper model for a concrete model', async () => {
    const res = await make()({ model: 'pa/premium' });
    expect(res.headers['x-gateway-model']).toBe('pa/premium');
    expect(res.headers['x-gateway-route-reason']).toBe('concrete');
  });

  it('applies the policy requirements: quality tier and latency tier', async () => {
    const best = await make()({ model: 'gw/best-quality' });
    expect(best.headers['x-gateway-model']).toBe('pa/premium');
    const fast = await make()({
      model: 'gw/cheap-fast',
      tools: [{ type: 'function', function: { name: 'f' } }],
    });
    expect(fast.headers['x-gateway-model']).toBe('pb/budget'); // pa/premium is standard latency
  });

  it('lets explicit gateway fields override the policy', async () => {
    const res = await make()({ model: 'auto', gateway: { min_quality_tier: 2 } });
    expect(res.headers['x-gateway-model']).toBe('pc/mid');
  });

  it('never auto-routes a model marked routable: false, but serves it by name', async () => {
    const send = make();
    expect((await send({ model: 'auto' })).headers['x-gateway-model']).not.toBe('pa/failure-demo');
    expect((await send({ model: 'pa/failure-demo' })).headers['x-gateway-model']).toBe(
      'pa/failure-demo',
    );
  });

  it('excludes providers with no endpoint configured', async () => {
    const res = await make()({ model: 'auto' });
    expect(res.headers['x-gateway-model']).not.toBe('pf/unconfigured');
  });

  it('excludes models whose provider credential the tenant lacks', async () => {
    const res = await make()({ model: 'auto' });
    expect(res.headers['x-gateway-model']).not.toBe('pe/keyed');
  });
});
