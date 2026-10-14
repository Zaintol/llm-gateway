import { ConfigError, loadConfig, type Config } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db/client.js';
import { createRedis } from './redis.js';
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
const redis = createRedis(config.REDIS_URL);

const app = buildApp({
  logLevel: config.LOG_LEVEL,
  readinessTimeoutMs: config.READINESS_TIMEOUT_MS,
  readinessChecks: { postgres: postgresCheck(pool), redis: redisCheck(redis) },
});

redis.on('error', (err) => app.log.warn({ err: err.message }, 'redis connection error'));
pool.on('error', (err) => app.log.warn({ err: err.message }, 'postgres pool error'));
redis.connect().catch(() => {
  // Reported through /readyz; ioredis keeps retrying in the background.
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await Promise.allSettled([pool.end(), redis.quit()]);
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
