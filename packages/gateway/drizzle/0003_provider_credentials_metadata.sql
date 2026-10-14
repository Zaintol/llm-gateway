ALTER TABLE "provider_credentials" ADD COLUMN "label" text NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD COLUMN "last4" text NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD COLUMN "base_url" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "credential_scope" text;