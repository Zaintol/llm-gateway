ALTER TABLE "usage_events" DROP CONSTRAINT "usage_events_usage_source_check";--> statement-breakpoint
ALTER TABLE "usage_events" DROP CONSTRAINT "usage_events_status_check";--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "requested_model" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "fallback_used" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "ttft_ms" integer;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_usage_source_check" CHECK ("usage_source" in ('provider', 'estimated', 'none'));--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_status_check" CHECK ("status" in ('success', 'error', 'partial', 'client_cancelled'));