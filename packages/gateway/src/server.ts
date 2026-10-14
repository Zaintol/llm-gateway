import { ConfigError, loadConfig, type Config } from './config.js';
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
subscribeToKeyInvalidations(subscriber, authenticator).catch((err: unknown) =>
  app.log.warn({ err }, 'auth invalidation subscription failed; relying on cache TTL'),
);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  catalog.stop();
  clearInterval(spillTimer);
  await app.close();
  await usageRecorder.flush();
  await usageQueue.close();
  await Promise.allSettled([pool.end(), redis.quit(), subscriber.quit()]);
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
