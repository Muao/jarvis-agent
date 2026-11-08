ALTER TABLE "runs" ADD COLUMN "stop_reason" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "model_usage" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_stop_reason_check" CHECK ("runs"."stop_reason" is null or "stop_reason" in ('success', 'max_turns', 'budget', 'error', 'rate_limited', 'cancelled', 'killed'));