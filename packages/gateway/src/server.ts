import { ConfigError, loadConfig, type Config } from './config.js';
import { buildApp } from './app.js';
import { Authenticator } from './auth/authenticator.js';
import { RedisFailureLimiter } from './auth/failure-limiter.js';
import { subscribeToKeyInvalidations } from './auth/invalidation.js';
import { PgKeyStore } from './auth/key-store.js';
import { chatRoutes } from './chat/route.js';
import { CredentialResolver, keyProviderFromConfig } from './credentials/service.js';
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

const providers = new ProviderRegistry([
  new OpenAiCompatibleAdapter({ provider: 'openai', defaultBaseUrl: config.OPENAI_BASE_URL }),
  ...(config.MOCK_PROVIDER_BASE_URL
    ? [
        new OpenAiCompatibleAdapter({
          provider: 'mock',
          defaultBaseUrl: config.MOCK_PROVIDER_BASE_URL,
          requiresCredential: false,
        }),
      ]
    : []),
]);
const credentials = new CredentialResolver(db, keyProviderFromConfig(config));

const app = buildApp({
  logLevel: config.LOG_LEVEL,
  trustProxy: config.TRUST_PROXY,
  bodyLimitBytes: config.REQUEST_BODY_LIMIT_BYTES,
  readinessTimeoutMs: config.READINESS_TIMEOUT_MS,
  readinessChecks: { postgres: postgresCheck(pool), redis: redisCheck(redis) },
  auth: { authenticator, failureLimiter },
  dataPlaneRoutes: [
    chatRoutes({ providers, credentials, providerTimeoutMs: config.PROVIDER_TIMEOUT_MS }),
  ],
});

redis.on('error', (err) => app.log.warn({ err: err.message }, 'redis connection error'));
subscriber.on('error', (err) => app.log.warn({ err: err.message }, 'redis subscriber error'));
pool.on('error', (err) => app.log.warn({ err: err.message }, 'postgres pool error'));
redis.connect().catch(() => {
  // Reported through /readyz; ioredis keeps retrying in the background.
});
subscribeToKeyInvalidations(subscriber, authenticator).catch((err: unknown) =>
  app.log.warn({ err }, 'auth invalidation subscription failed; relying on cache TTL'),
);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await Promise.allSettled([pool.end(), redis.quit(), subscriber.quit()]);
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
