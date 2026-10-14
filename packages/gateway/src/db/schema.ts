import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Money is stored as integer micro-USD (1 USD = 1_000_000) everywhere.
 * `mode: 'bigint'` keeps values exact in JS instead of going through floating point.
 */
const micros = (name: string) => bigint(name, { mode: 'bigint' });

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    status: text('status', { enum: ['active', 'suspended'] })
      .notNull()
      .default('active'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('tenants_status_check', sql`${t.status} in ('active', 'suspended')`)],
);

export const tenantSettings = pgTable('tenant_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Public lookup part of `gw_live_<prefix>_<secret>`. */
    prefix: text('prefix').notNull().unique(),
    /** SHA-256 hex digest of the secret part; the secret itself is never stored. */
    secretHash: text('secret_hash').notNull(),
    /** Actor id of whoever created the key (admin user, or `cli:<os user>`). */
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('api_keys_tenant_idx').on(t.tenantId)],
);

/** Envelope-encrypted (AES-256-GCM) upstream credentials. A null tenant means a global credential. */
export const providerCredentials = pgTable(
  'provider_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    label: text('label').notNull(),
    /** Last 4 characters of the secret, the only part ever shown back. */
    last4: text('last4').notNull(),
    /** Override for OpenAI-compatible or proxy endpoints; null uses the provider default. */
    baseUrl: text('base_url'),
    ciphertext: bytea('ciphertext').notNull(),
    iv: bytea('iv').notNull(),
    authTag: bytea('auth_tag').notNull(),
    wrappedDek: bytea('wrapped_dek').notNull(),
    masterKeyVersion: integer('master_key_version').notNull(),
    createdAt: createdAt(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  },
  (t) => [
    unique('provider_credentials_tenant_provider_uq').on(t.tenantId, t.provider).nullsNotDistinct(),
  ],
);

export const models = pgTable(
  'models',
  {
    /** `provider/model`, e.g. `openai/gpt-4o-mini`. */
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    upstreamModelName: text('upstream_model_name').notNull(),
    contextWindow: integer('context_window').notNull(),
    maxOutputTokens: integer('max_output_tokens').notNull(),
    supportsTools: boolean('supports_tools').notNull().default(false),
    supportsVision: boolean('supports_vision').notNull().default(false),
    supportsJsonMode: boolean('supports_json_mode').notNull().default(false),
    supportsStreaming: boolean('supports_streaming').notNull().default(true),
    qualityTier: smallint('quality_tier').notNull(),
    latencyTier: text('latency_tier', { enum: ['fast', 'standard', 'slow'] }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    check('models_quality_tier_check', sql`${t.qualityTier} between 1 and 3`),
    check('models_latency_tier_check', sql`${t.latencyTier} in ('fast', 'standard', 'slow')`),
    check('models_context_window_check', sql`${t.contextWindow} > 0`),
  ],
);

/** Append-only and versioned: a price change closes the open row and inserts a new one. */
export const modelPrices = pgTable(
  'model_prices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelId: text('model_id')
      .notNull()
      .references(() => models.id),
    inputPricePerMtokMicros: micros('input_price_per_mtok_micros').notNull(),
    outputPricePerMtokMicros: micros('output_price_per_mtok_micros').notNull(),
    cachedInputPricePerMtokMicros: micros('cached_input_price_per_mtok_micros'),
    currency: text('currency').notNull().default('USD'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    sourceUrl: text('source_url').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('model_prices_one_open_price_uq')
      .on(t.modelId)
      .where(sql`${t.effectiveTo} is null`),
    check(
      'model_prices_non_negative_check',
      sql`${t.inputPricePerMtokMicros} >= 0 and ${t.outputPricePerMtokMicros} >= 0 and coalesce(${t.cachedInputPricePerMtokMicros}, 0) >= 0`,
    ),
    check(
      'model_prices_effective_range_check',
      sql`${t.effectiveTo} is null or ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
  ],
);

/** Virtual models such as `auto` or `gw/cheap-fast`. */
export const routingPolicies = pgTable('routing_policies', {
  id: text('id').primaryKey(),
  description: text('description').notNull(),
  requirements: jsonb('requirements').notNull().default({}),
  fallbackChain: text('fallback_chain')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: createdAt(),
});

export const budgets = pgTable(
  'budgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Null means the budget applies to the whole tenant. */
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'cascade' }),
    period: text('period', { enum: ['daily', 'monthly'] }).notNull(),
    hardLimitMicros: micros('hard_limit_micros'),
    softLimitMicros: micros('soft_limit_micros'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('budgets_scope_period_uq').on(t.tenantId, t.apiKeyId, t.period).nullsNotDistinct(),
    check('budgets_period_check', sql`${t.period} in ('daily', 'monthly')`),
    check(
      'budgets_limits_check',
      sql`coalesce(${t.hardLimitMicros}, 0) >= 0 and coalesce(${t.softLimitMicros}, 0) >= 0`,
    ),
  ],
);

/**
 * Range-partitioned by month on `created_at` (see migration 0001). No foreign keys: this is the
 * highest-volume table and rows must survive tenant or key deletion for financial history.
 */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').notNull().defaultRandom(),
    requestId: text('request_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    apiKeyId: uuid('api_key_id').notNull(),
    modelId: text('model_id').notNull(),
    provider: text('provider').notNull(),
    priceId: uuid('price_id'),
    credentialScope: text('credential_scope', { enum: ['tenant', 'platform'] }),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    costMicros: micros('cost_micros').notNull(),
    usageSource: text('usage_source', { enum: ['provider', 'estimated'] }).notNull(),
    status: text('status', { enum: ['success', 'error', 'aborted'] }).notNull(),
    attempts: smallint('attempts').notNull().default(1),
    latencyMs: integer('latency_ms'),
    routeReason: text('route_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.createdAt] }),
    // Unique indexes on a partitioned table must include the partition key.
    uniqueIndex('usage_events_request_uq').on(t.requestId, t.createdAt),
    index('usage_events_tenant_created_idx').on(t.tenantId, t.createdAt),
    check('usage_events_cost_check', sql`${t.costMicros} >= 0`),
    check('usage_events_usage_source_check', sql`${t.usageSource} in ('provider', 'estimated')`),
    check('usage_events_status_check', sql`${t.status} in ('success', 'error', 'aborted')`),
  ],
);

export const usageRollupsHourly = pgTable(
  'usage_rollups_hourly',
  {
    tenantId: uuid('tenant_id').notNull(),
    modelId: text('model_id').notNull(),
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    requestCount: integer('request_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    costMicros: micros('cost_micros')
      .notNull()
      .default(sql`0`),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.modelId, t.hour] }),
    index('usage_rollups_hourly_hour_idx').on(t.hour),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    actorType: text('actor_type', { enum: ['admin', 'api_key', 'system'] }).notNull(),
    actorId: text('actor_id').notNull(),
    tenantId: uuid('tenant_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('audit_log_tenant_created_idx').on(t.tenantId, t.createdAt)],
);
