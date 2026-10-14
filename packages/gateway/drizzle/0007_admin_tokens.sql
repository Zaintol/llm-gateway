CREATE TABLE "admin_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"role" text NOT NULL,
	"tenant_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "admin_tokens_prefix_unique" UNIQUE("prefix"),
	CONSTRAINT "admin_tokens_role_check" CHECK ("admin_tokens"."role" in ('platform_admin', 'tenant_admin', 'finance_viewer')),
	CONSTRAINT "admin_tokens_scope_check" CHECK (("admin_tokens"."role" = 'platform_admin') = ("admin_tokens"."tenant_id" is null))
);
--> statement-breakpoint
ALTER TABLE "admin_tokens" ADD CONSTRAINT "admin_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;