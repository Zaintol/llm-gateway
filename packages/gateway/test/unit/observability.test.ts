import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { parse } from 'yaml';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { StaticCatalog } from '../../src/catalog/catalog.js';
import { chatRoutes } from '../../src/chat/route.js';
import { ExecutionEngine } from '../../src/execution/engine.js';
import {
  REDACT_PATHS,
  loggerOptions,
  promptLoggingAllowed,
} from '../../src/observability/logging.js';
import { initTracing } from '../../src/observability/tracing.js';
import { ProviderError } from '../../src/providers/errors.js';
import { ProviderRegistry } from '../../src/providers/registry.js';
import {
  FakeAdapter,
  StaticCredentials,
  cannedResult,
  catalogModel,
  fakeAuth,
} from '../support/fakes.js';

const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;
beforeAll(() => {
  provider = initTracing({
    serviceName: 'test',
    sampleRatio: 1,
    processors: [new SimpleSpanProcessor(exporter)],
  });
});
afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});
beforeEach(() => exporter.reset());

const MARKER = 'TOP-SECRET-PROMPT-91c2';
const catalog = new StaticCatalog(
  [
    catalogModel({ id: 'openai/gpt', provider: 'openai', upstreamModel: 'gpt' }),
    catalogModel({ id: 'anthropic/claude', provider: 'anthropic', upstreamModel: 'claude' }),
  ],
  [
    {
      id: 'gw/chain',
      description: '',
      requirements: {},
      fallbackChain: ['openai/gpt', 'anthropic/claude'],
      enabled: true,
    },
  ],
);

let app: FastifyInstance;
let lines: Array<Record<string, unknown>>;
let rawLog: string;
afterEach(() => app?.close());

function make(options: { logPrompts?: boolean } = {}) {
  lines = [];
  rawLog = '';
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      rawLog += chunk.toString();
      for (const line of chunk.toString().split('\n').filter(Boolean)) lines.push(JSON.parse(line));
      cb();
    },
  });
  const openai = new FakeAdapter('openai', () => {
    throw new ProviderError('provider_error', 'openai', 'upstream 503', 503);
  });
  const anthropic = new FakeAdapter('anthropic', (req) =>
    cannedResult(req.model, `echo ${MARKER}`),
  );
  const fakes = fakeAuth();
  const { key, record } = fakes.store.add({ tenantId: 'tenant_obs' });
  app = buildApp({
    logLevel: 'debug',
    logStream,
    readinessChecks: {},
    readinessTimeoutMs: 50,
    auth: fakes.auth,
    dataPlaneRoutes: [
      chatRoutes({
        flags: { ff_cost_aware_routing: false },
        providers: new ProviderRegistry([openai, anthropic], catalog),
        catalog,
        credentials: new StaticCredentials(),
        engine: new ExecutionEngine({ sleep: async () => {}, maxRetries: 0 }),
        logPrompts: options.logPrompts ?? false,
      }),
    ],
  });
  const send = (headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}`, ...headers },
      payload: { model: 'gw/chain', messages: [{ role: 'user', content: MARKER }] },
    });
  return { send, key, record };
}

const spans = () => exporter.getFinishedSpans();
const named = (name: string) => spans().filter((s) => s.name === name);
const root = () => named('POST /v1/chat/completions')[0]!;
const parentId = (s: ReadableSpan) => s.parentSpanContext?.spanId;

describe('tracing (GW-8.1)', () => {
  it('shows a fallback as two provider.attempt spans, error then success, under one root span', async () => {
    const res = await make().send();
    expect(res.statusCode).toBe(200);
    const attempts = named('provider.attempt');
    expect(
      attempts.map((s) => [s.attributes['gen_ai.system'], s.attributes['gateway.outcome']]),
    ).toEqual([
      ['openai', 'provider_error'],
      ['anthropic', 'success'],
    ]);
    const rootSpan = root();
    for (const attempt of attempts) {
      expect(attempt.spanContext().traceId).toBe(rootSpan.spanContext().traceId);
      expect(parentId(attempt)).toBe(rootSpan.spanContext().spanId);
    }
    expect(attempts[0]!.attributes['http.response.status_code']).toBe(503);
    expect(attempts[1]!.attributes).toMatchObject({
      'gen_ai.request.model': 'claude',
      'gen_ai.usage.input_tokens': 3,
      'gen_ai.usage.output_tokens': 1,
    });
    expect(res.headers['x-trace-id']).toBe(rootSpan.spanContext().traceId);
  });

  it('records a span for every pipeline stage', async () => {
    await make().send();
    const names = new Set(spans().map((s) => s.name));
    for (const stage of ['auth', 'validate', 'route', 'ratelimit', 'provider.attempt', 'meter']) {
      expect(names).toContain(stage);
    }
  });

  it('continues an incoming W3C traceparent', async () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const parentSpanId = '00f067aa0ba902b7';
    await make().send({ traceparent: `00-${traceId}-${parentSpanId}-01` });
    expect(root().spanContext().traceId).toBe(traceId);
    expect(parentId(root())).toBe(parentSpanId);
  });

  it('puts tenant, key prefix, served model, attempts and cost on the root span', async () => {
    const { send, record } = make();
    await send();
    expect(root().attributes).toMatchObject({
      'tenant.id': 'tenant_obs',
      'key.prefix': record.prefix,
      'gateway.served_model': 'anthropic/claude',
      'gateway.attempts': 2,
      'http.response.status_code': 200,
    });
    expect(root().attributes['gateway.cost_usd']).toBeTypeOf('number');
  });

  it('never puts message content in any span', async () => {
    await make().send();
    for (const span of spans()) {
      expect(
        JSON.stringify({ name: span.name, attributes: span.attributes, events: span.events }),
      ).not.toContain(MARKER);
    }
  });

  it('does not trace health probes', async () => {
    make();
    await app.inject('/healthz');
    expect(spans()).toHaveLength(0);
  });
});

describe('structured logging (GW-8.3)', () => {
  it('writes exactly one access line per request with the required fields', async () => {
    const res = await make().send();
    const access = lines.filter((l) => l.msg === 'request completed');
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({
      request_id: res.headers['x-request-id'],
      trace_id: root().spanContext().traceId,
      status: 200,
      served_model: 'anthropic/claude',
      attempts: 2,
      latency_ms: expect.any(Number),
      cost_usd: expect.any(Number),
      tenant_id: 'tenant_obs',
    });
  });

  it('correlates other log lines with the active trace', async () => {
    await make().send();
    const fallbackLine = lines.find((l) => l.msg === 'request needed retries or fallback');
    expect(fallbackLine?.trace_id).toBe(root().spanContext().traceId);
  });

  it('never logs the bearer token or message text, even at debug level', async () => {
    const { send, key } = make();
    await send();
    expect(rawLog.length).toBeGreaterThan(0);
    expect(rawLog).not.toContain(key);
    expect(rawLog).not.toContain(MARKER);
  });

  it('logs prompts only when explicitly allowed in development', async () => {
    const { send } = make({ logPrompts: true });
    await send();
    expect(rawLog).toContain(MARKER);
    expect(promptLoggingAllowed(true, 'development')).toBe(true);
    expect(promptLoggingAllowed(true, 'production')).toBe(false);
    expect(promptLoggingAllowed(false, 'development')).toBe(false);
  });

  it('redacts every known secret and content field', () => {
    let out = '';
    const logger = pino(loggerOptions('trace'), { write: (s: string) => void (out += s) });
    const secret = 'sk-live-SHOULD-NOT-APPEAR';
    logger.info(
      {
        req: {
          headers: { authorization: `Bearer ${secret}`, 'x-api-key': secret, cookie: secret },
        },
        headers: { authorization: secret, 'x-api-key': secret },
        authorization: secret,
        secret,
        apiKey: secret,
        key: secret,
        credential: { secret },
        nested: {
          secret,
          apiKey: secret,
          authorization: secret,
          credential: secret,
          messages: [secret],
          content: secret,
        },
        deep: { inner: { secret } },
        body: { messages: [{ role: 'user', content: secret }] },
        messages: [{ role: 'user', content: secret }],
        choices: [{ message: { content: secret } }],
        content: secret,
        prompt: secret,
        tools: [secret],
      },
      'redaction check',
    );
    expect(out).toContain('redaction check');
    expect(out).not.toContain(secret);
    expect(REDACT_PATHS.length).toBeGreaterThan(10);
  });
});

describe('tail sampling (GW-8.1)', () => {
  it('keeps every error trace and samples the rest', () => {
    const file = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../infra/otel-collector.yaml',
    );
    const config = parse(readFileSync(file, 'utf8'));
    const policies = config.processors.tail_sampling.policies;
    expect(policies).toContainEqual({
      name: 'keep-errors',
      type: 'status_code',
      status_code: { status_codes: ['ERROR'] },
    });
    expect(config.service.pipelines.traces.processors[0]).toBe('tail_sampling');
  });
});
