import { ConfigError, loadConfig, type Config } from './config.js';
import { promptLoggingAllowed } from './observability/logging.js';
import { initTracing } from './observability/tracing.js';
import { buildApp } from './app.js';
import { Authenticator } from './auth/authenticator.js';
import { RedisFailureLimiter } from './auth/failure-limiter.js';
import { subscribeToKeyInvalidations } from './auth/invalidation.js';
import { PgKeyStore } from './auth/key-store.js';
import { PgCatalog } from './catalog/catalog.js';
import { modelsRoutes } from './catalog/route.js';
import { chatRoutes } from './chat/route.js';
import { ExecutionEngine } from './execution/engine.js';
import { createUsageQueue } from './metering/queue.js';
import { RedisRateLimiter } from './ratelimit/limiter.js';
import { BudgetLedger } from './budget/ledger.js';
import { BudgetService, PgBudgetSource, reconcileBudgets } from './budget/service.js';
import { QueueUsageRecorder } from './metering/recorder.js';
import { SpillFile } from './metering/spill.js';
import { providerFetch } from './providers/fetch.js';
import { CredentialResolver, keyProviderFromConfig } from './credentials/service.js';
import { AnthropicAdapter } from './providers/anthropic.js';
import { OpenAiCompatibleAdapter } from './providers/openai-compatible.js';
import { ProviderRegistry } from './providers/registry.js';
import { createDb, createPool } from './db/client.js';
import { createRedis, createSubscriber } from './redis.js';
import { postgresCheck, redisCheck } from './readiness.js';

function readConfig(): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Logged as plain stderr: the logger itself depends on configuration.
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

const config = readConfig();
// Tracing must be registered before any request is served; spans are no-ops without an endpoint.
const tracing = config.OTEL_EXPORTER_OTLP_ENDPOINT
  ? initTracing({
      serviceName: 'llm-gateway',
      endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT,
      sampleRatio: config.OTEL_TRACES_SAMPLE_RATIO,
    })
  : undefined;
const logPrompts = promptLoggingAllowed(config.LOG_PROMPTS, config.NODE_ENV);
const pool = createPool(config.DATABASE_URL);
const db = createDb(pool);
const redis = createRedis(config.REDIS_URL);
const subscriber = createSubscriber(config.REDIS_URL);

const authenticator = new Authenticator(new PgKeyStore(db), {
  onTouchError: (err) => app.log.warn({ err }, 'failed to update api key last_used_at'),
});
const failureLimiter = new RedisFailureLimiter(redis, {
  onError: (err) => app.log.warn({ err }, 'auth failure limiter unavailable; failing open'),
});

const catalog = new PgCatalog(db, {
  onError: (err) => app.log.warn({ err }, 'model catalog refresh failed'),
});
const fetchUpstream = providerFetch({ connectTimeoutMs: config.PROVIDER_CONNECT_TIMEOUT_MS });
const providers = new ProviderRegistry(
  [
    new OpenAiCompatibleAdapter({
      provider: 'openai',
      defaultBaseUrl: config.OPENAI_BASE_URL,
      fetch: fetchUpstream,
    }),
    new AnthropicAdapter({ defaultBaseUrl: config.ANTHROPIC_BASE_URL, fetch: fetchUpstream }),
    // Local models need no key; the endpoint comes from a credential row or LOCAL_MODELS_BASE_URL.
    new OpenAiCompatibleAdapter({
      provider: 'local',
      ...(config.LOCAL_MODELS_BASE_URL ? { defaultBaseUrl: config.LOCAL_MODELS_BASE_URL } : {}),
      requiresCredential: false,
    }),
    ...(config.MOCK_PROVIDER_BASE_URL
      ? [
          new OpenAiCompatibleAdapter({
            provider: 'mock',
            defaultBaseUrl: config.MOCK_PROVIDER_BASE_URL,
            requiresCredential: false,
          }),
        ]
      : []),
  ],
  catalog,
);
const credentials = new CredentialResolver(db, keyProviderFromConfig(config));

const usageQueue = createUsageQueue(config.REDIS_URL, {
  attempts: config.USAGE_JOB_ATTEMPTS,
  backoffMs: config.USAGE_JOB_BACKOFF_MS,
});
const usageRecorder = new QueueUsageRecorder(usageQueue, new SpillFile(config.USAGE_SPILL_PATH), {
  warn: (obj, msg) => app.log.warn(obj, msg),
  error: (obj, msg) => app.log.error(obj, msg),
});

const budgetLedger = new BudgetLedger(redis, config.BUDGET_LEASE_MS);
const budgetService = new BudgetService(budgetLedger, new PgBudgetSource(db), (err) =>
  app.log.warn({ err }, 'budget ledger unavailable'),
);

const app = buildApp({
  logLevel: config.LOG_LEVEL,
  trustProxy: config.TRUST_PROXY,
  bodyLimitBytes: config.REQUEST_BODY_LIMIT_BYTES,
  ...(config.METRICS_TOKEN ? { metricsToken: config.METRICS_TOKEN } : {}),
  readinessTimeoutMs: config.READINESS_TIMEOUT_MS,
  readinessChecks: { postgres: postgresCheck(pool), redis: redisCheck(redis) },
  auth: { authenticator, failureLimiter },
  dataPlaneRoutes: [
    modelsRoutes({ catalog, providers }),
    chatRoutes({
      providers,
      catalog,
      credentials,
      engine: new ExecutionEngine({
        maxRetries: config.RETRY_MAX_RETRIES,
        backoffBaseMs: config.RETRY_BACKOFF_BASE_MS,
        backoffCapMs: config.RETRY_BACKOFF_CAP_MS,
        attemptTimeoutMs: config.PROVIDER_ATTEMPT_TIMEOUT_MS,
        firstTokenTimeoutMs: config.PROVIDER_FIRST_TOKEN_TIMEOUT_MS,
      }),
      stream: {
        idleTimeoutMs: config.STREAM_IDLE_TIMEOUT_MS,
        heartbeatMs: config.STREAM_HEARTBEAT_MS,
      },
      usage: usageRecorder,
      budgets: budgetService,
      logPrompts,
      flags: { ff_cost_aware_routing: config.FF_COST_AWARE_ROUTING },
      rateLimiter: new RedisRateLimiter(redis, (err) =>
        app.log.warn({ err }, 'rate limiter unavailable; admitting requests without limits'),
      ),
      deadline: {
        defaultMs: config.REQUEST_DEADLINE_DEFAULT_MS,
        maxMs: config.REQUEST_DEADLINE_MAX_MS,
      },
    }),
  ],
});

if (config.LOG_PROMPTS && !logPrompts) {
  app.log.warn(
    { NODE_ENV: config.NODE_ENV },
    'LOG_PROMPTS is set but ignored: prompt logging is only allowed when NODE_ENV=development',
  );
}
if (!tracing) app.log.info('tracing disabled: OTEL_EXPORTER_OTLP_ENDPOINT is not set');

redis.on('error', (err) => app.log.warn({ err: err.message }, 'redis connection error'));
subscriber.on('error', (err) => app.log.warn({ err: err.message }, 'redis subscriber error'));
pool.on('error', (err) => app.log.warn({ err: err.message }, 'postgres pool error'));
redis.connect().catch(() => {
  // Reported through /readyz; ioredis keeps retrying in the background.
});
catalog.start();
usageQueue.on('error', (err) => app.log.warn({ err: err.message }, 'usage queue error'));
// Replay events spilled while Redis was unreachable: now, and periodically afterwards.
const replaySpill = () =>
  usageRecorder
    .replaySpill()
    .then((n) => n > 0 && app.log.info({ replayed: n }, 'replayed spilled usage events'))
    .catch((err: unknown) => app.log.warn({ err }, 'usage spill replay failed; will retry'));
void replaySpill();
const spillTimer = setInterval(replaySpill, 60_000);
spillTimer.unref();

// Refund reservations orphaned by crashed instances.
const sweepTimer = setInterval(() => {
  budgetLedger
    .sweep()
    .then((n) => n > 0 && app.log.warn({ refunded: n }, 'refunded expired budget reservations'))
    .catch((err: unknown) => app.log.warn({ err }, 'budget sweep failed'));
}, config.BUDGET_SWEEP_INTERVAL_MS);
sweepTimer.unref();

// Rebuild budget counters from Postgres. A short Redis lock keeps it to one instance per run.
const reconcile = async () => {
  try {
    const lock = await redis.set(
      'gw:budget:reconcile:lock',
      String(process.pid),
      'PX',
      config.BUDGET_RECONCILE_INTERVAL_MS - 1_000,
      'NX',
    );
    if (lock !== 'OK') return;
    const count = await reconcileBudgets(db, budgetLedger);
    app.log.info({ tenants: count }, 'reconciled budget counters');
  } catch (err) {
    app.log.warn({ err }, 'budget reconciliation failed; will retry');
  }
};
setTimeout(() => void reconcile(), 5_000).unref();
const reconcileTimer = setInterval(() => void reconcile(), config.BUDGET_RECONCILE_INTERVAL_MS);
reconcileTimer.unref();
subscribeToKeyInvalidations(subscriber, authenticator).catch((err: unknown) =>
  app.log.warn({ err }, 'auth invalidation subscription failed; relying on cache TTL'),
);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  catalog.stop();
  clearInterval(spillTimer);
  clearInterval(sweepTimer);
  clearInterval(reconcileTimer);
  await app.close();
  await tracing?.shutdown();
  await usageRecorder.flush();
  await usageQueue.close();
  await Promise.allSettled([pool.end(), redis.quit(), subscriber.quit()]);
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
