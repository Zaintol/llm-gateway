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
