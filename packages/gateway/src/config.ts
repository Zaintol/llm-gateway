import { z } from 'zod';

const masterKey = z
  .string()
  .refine((v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, 'base64').length === 32, {
    message: 'must be 32 bytes, base64-encoded (openssl rand -base64 32)',
  });

/** `<version>:<base64 key>` pairs, comma-separated, kept only while rotating the master key. */
const previousMasterKeys = z
  .string()
  .default('')
  .transform((v, ctx) => {
    const keys = new Map<number, string>();
    for (const entry of v
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)) {
      const [version, key] = entry.split(':');
      const parsed = masterKey.safeParse(key);
      if (!/^\d+$/.test(version ?? '') || !parsed.success) {
        ctx.addIssue({
          code: 'custom',
          message: 'entries must look like <version>:<32-byte base64 key>',
        });
        return z.NEVER;
      }
      keys.set(Number(version), parsed.data);
    }
    return keys;
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  READINESS_TIMEOUT_MS: z.coerce.number().int().positive().default(1000),
  GATEWAY_MASTER_KEY: masterKey,
  GATEWAY_MASTER_KEY_VERSION: z.coerce.number().int().positive().default(1),
  GATEWAY_PREVIOUS_MASTER_KEYS: previousMasterKeys,
  /** Largest accepted request body; larger requests get 413 before any provider is called. */
  REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
  /** Overall request deadline when the client sends no x-gateway-timeout-ms, and its cap. */
  REQUEST_DEADLINE_DEFAULT_MS: z.coerce.number().int().positive().default(60_000),
  REQUEST_DEADLINE_MAX_MS: z.coerce.number().int().positive().default(300_000),
  /** TCP/TLS connect timeout to providers. */
  PROVIDER_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
  /**
   * Upper bound for one non-streaming attempt. Providers send nothing until the whole completion
   * is ready, so this must cover generation time; streaming adds a first-token timeout (GW-2.6).
   */
  PROVIDER_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  /** Streaming: wait this long for the first event before trying the next attempt or candidate. */
  PROVIDER_FIRST_TOKEN_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  /** Streaming: end the stream with an error if the provider sends nothing for this long. */
  STREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  STREAM_HEARTBEAT_MS: z.coerce.number().int().positive().default(15_000),
  RETRY_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  RETRY_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(200),
  RETRY_BACKOFF_CAP_MS: z.coerce.number().int().positive().default(2_000),
  OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
  ANTHROPIC_BASE_URL: z.url().default('https://api.anthropic.com'),
  /** Default OpenAI-compatible endpoint for `local/*` models (Ollama, vLLM). A credential's base_url overrides it. */
  LOCAL_MODELS_BASE_URL: z.url().optional(),
  /** When set, registers the `mock` provider (no credential needed). Used by tests and the demo. */
  MOCK_PROVIDER_BASE_URL: z.url().optional(),
  /** Usage events that cannot be queued (Redis down) are appended here and replayed later. */
  USAGE_SPILL_PATH: z.string().min(1).default('./data/usage-spill.ndjson'),
  /** Worker retries per usage event before it lands in the dead-letter queue. */
  USAGE_JOB_ATTEMPTS: z.coerce.number().int().positive().default(5),
  /** Exponential backoff base: 5s gives ~2.5 minutes of retries across 5 attempts. */
  USAGE_JOB_BACKOFF_MS: z.coerce.number().int().positive().default(5_000),
  /** Bearer token for GET /metrics; unset leaves it open (fine on a private network). */
  METRICS_TOKEN: z.string().min(16).optional(),
  /** Open budget reservations are refunded if not settled within this lease (crashed instance). */
  BUDGET_LEASE_MS: z.coerce.number().int().positive().default(600_000),
  BUDGET_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /** How often Redis budget counters are rebuilt from usage_events (the source of truth). */
  BUDGET_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** Parses the environment, collecting every problem rather than stopping at the first. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const name = issue.path.join('.');
        return env[name] === undefined ? `${name} is required` : `${name}: ${issue.message}`;
      }),
    );
  }
  return result.data;
}
