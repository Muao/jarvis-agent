ALTER TABLE "tasks" ADD COLUMN "kind" text DEFAULT 'build' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_kind_check" CHECK ("kind" in ('build', 'ui_check'));