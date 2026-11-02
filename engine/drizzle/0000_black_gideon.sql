CREATE SEQUENCE "public"."task_ids" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"ord" bigserial NOT NULL,
	"thread_id" text NOT NULL,
	"task_id" text,
	"kind" text NOT NULL,
	"body" jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"answer" jsonb,
	"answered_at" timestamp with time zone,
	CONSTRAINT "messages_kind_check" CHECK ("kind" in ('owner', 'jarvis', 'status', 'decision', 'question', 'permission', 'result', 'system'))
);
--> statement-breakpoint
CREATE TABLE "permission_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"ord" bigserial NOT NULL,
	"run_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"task_id" text,
	"tool" text NOT NULL,
	"description" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "permission_requests_status_check" CHECK ("status" in ('pending', 'allow', 'deny', 'timeout'))
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"parent_tool_use_id" text,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"ord" bigserial NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"thread_id" text NOT NULL,
	"task_id" text,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"tokens_input" bigint DEFAULT 0 NOT NULL,
	"tokens_output" bigint DEFAULT 0 NOT NULL,
	"tokens_cache_read" bigint DEFAULT 0 NOT NULL,
	"tokens_cache_write" bigint DEFAULT 0 NOT NULL,
	"exit_code" integer,
	"error" text,
	CONSTRAINT "runs_role_check" CHECK ("role" in ('dispatcher', 'worker')),
	CONSTRAINT "runs_status_check" CHECK ("status" in ('running', 'completed', 'failed', 'stopped', 'limit_reached', 'interrupted'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"thread_id" text NOT NULL,
	"task_id" text,
	"claude_session_id" text,
	CONSTRAINT "sessions_role_check" CHECK ("role" in ('dispatcher', 'worker'))
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"type" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor" text NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "task_events_actor_check" CHECK ("actor" in ('system', 'agent', 'owner'))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"ord" bigserial NOT NULL,
	"thread_id" text NOT NULL,
	"title" text NOT NULL,
	"stage" text NOT NULL,
	"resume_stage" text,
	"branch" text NOT NULL,
	"pr_number" integer,
	"pr_url" text,
	"check_retries" integer DEFAULT 0 NOT NULL,
	"ci_fix_rounds" integer DEFAULT 0 NOT NULL,
	"review_rounds" integer DEFAULT 0 NOT NULL,
	"worker_session_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"reason" text,
	CONSTRAINT "tasks_stage_check" CHECK ("stage" in ('Intake', 'Context', 'Spec Review', 'Implementing', 'Verifying', 'Reviewing', 'PR Open', 'Fixing', 'Done', 'Blocked', 'Failed', 'Cancelled')),
	CONSTRAINT "tasks_resume_stage_check" CHECK ("tasks"."resume_stage" is null or "resume_stage" in ('Intake', 'Context', 'Spec Review', 'Implementing', 'Verifying', 'Reviewing', 'PR Open', 'Fixing', 'Done', 'Blocked', 'Failed', 'Cancelled'))
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watches" (
	"task_id" text PRIMARY KEY NOT NULL,
	"pr_number" integer NOT NULL,
	"state" jsonb,
	"last_checked_at" timestamp with time zone,
	"summary" jsonb,
	"last_green" jsonb,
	"rerun_head_sha" text
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_requests" ADD CONSTRAINT "permission_requests_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_requests" ADD CONSTRAINT "permission_requests_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_requests" ADD CONSTRAINT "permission_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_thread_at_idx" ON "messages" USING btree ("thread_id","at");--> statement-breakpoint
CREATE INDEX "messages_task_idx" ON "messages" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "permission_requests_status_idx" ON "permission_requests" USING btree ("status","requested_at");--> statement-breakpoint
CREATE INDEX "permission_requests_run_idx" ON "permission_requests" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_seq_idx" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "runs_task_idx" ON "runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "runs_started_at_idx" ON "runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "runs_thread_idx" ON "runs" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "sessions_thread_role_idx" ON "sessions" USING btree ("thread_id","role");--> statement-breakpoint
CREATE INDEX "task_events_task_seq_idx" ON "task_events" USING btree ("task_id","seq");--> statement-breakpoint
CREATE INDEX "tasks_thread_idx" ON "tasks" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "tasks_stage_idx" ON "tasks" USING btree ("stage");