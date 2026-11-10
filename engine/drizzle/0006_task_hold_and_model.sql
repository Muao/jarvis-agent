ALTER TABLE "tasks" ADD COLUMN "held" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_model_check" CHECK ("tasks"."model" is null or "model" in ('fable', 'opus', 'sonnet', 'haiku'));