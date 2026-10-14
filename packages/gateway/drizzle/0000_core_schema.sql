CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_prefix_unique" UNIQUE("prefix")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"tenant_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"api_key_id" uuid,
	"period" text NOT NULL,
	"hard_limit_micros" bigint,
	"soft_limit_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budgets_scope_period_uq" UNIQUE NULLS NOT DISTINCT("tenant_id","api_key_id","period"),
	CONSTRAINT "budgets_period_check" CHECK ("budgets"."period" in ('daily', 'monthly')),
	CONSTRAINT "budgets_limits_check" CHECK (coalesce("budgets"."hard_limit_micros", 0) >= 0 and coalesce("budgets"."soft_limit_micros", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "model_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" text NOT NULL,
	"input_price_per_mtok_micros" bigint NOT NULL,
	"output_price_per_mtok_micros" bigint NOT NULL,
	"cached_input_price_per_mtok_micros" bigint,
	"currency" text DEFAULT 'USD' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"source_url" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_prices_non_negative_check" CHECK ("model_prices"."input_price_per_mtok_micros" >= 0 and "model_prices"."output_price_per_mtok_micros" >= 0 and coalesce("model_prices"."cached_input_price_per_mtok_micros", 0) >= 0),
	CONSTRAINT "model_prices_effective_range_check" CHECK ("model_prices"."effective_to" is null or "model_prices"."effective_to" > "model_prices"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"upstream_model_name" text NOT NULL,
	"context_window" integer NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"supports_tools" boolean DEFAULT false NOT NULL,
	"supports_vision" boolean DEFAULT false NOT NULL,
	"supports_json_mode" boolean DEFAULT false NOT NULL,
	"supports_streaming" boolean DEFAULT true NOT NULL,
	"quality_tier" smallint NOT NULL,
	"latency_tier" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "models_quality_tier_check" CHECK ("models"."quality_tier" between 1 and 3),
	CONSTRAINT "models_latency_tier_check" CHECK ("models"."latency_tier" in ('fast', 'standard', 'slow')),
	CONSTRAINT "models_context_window_check" CHECK ("models"."context_window" > 0)
);
--> statement-breakpoint
CREATE TABLE "provider_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"provider" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"master_key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "provider_credentials_tenant_provider_uq" UNIQUE NULLS NOT DISTINCT("tenant_id","provider")
);
--> statement-breakpoint
CREATE TABLE "routing_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"requirements" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fallback_chain" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenants_status_check" CHECK ("tenants"."status" in ('active', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"request_id" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"api_key_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	"provider" text NOT NULL,
	"price_id" uuid,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint NOT NULL,
	"usage_source" text NOT NULL,
	"status" text NOT NULL,
	"attempts" smallint DEFAULT 1 NOT NULL,
	"latency_ms" integer,
	"route_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_events_id_created_at_pk" PRIMARY KEY("id","created_at"),
	CONSTRAINT "usage_events_cost_check" CHECK ("usage_events"."cost_micros" >= 0),
	CONSTRAINT "usage_events_usage_source_check" CHECK ("usage_events"."usage_source" in ('provider', 'estimated')),
	CONSTRAINT "usage_events_status_check" CHECK ("usage_events"."status" in ('success', 'error', 'aborted'))
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE TABLE "usage_rollups_hourly" (
	"tenant_id" uuid NOT NULL,
	"model_id" text NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_rollups_hourly_tenant_id_model_id_hour_pk" PRIMARY KEY("tenant_id","model_id","hour")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_prices" ADD CONSTRAINT "model_prices_model_id_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_tenant_idx" ON "api_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_created_idx" ON "audit_log" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "model_prices_one_open_price_uq" ON "model_prices" USING btree ("model_id") WHERE "model_prices"."effective_to" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_request_uq" ON "usage_events" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_tenant_created_idx" ON "usage_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_rollups_hourly_hour_idx" ON "usage_rollups_hourly" USING btree ("hour");