import {
  MessageKindSchema,
  ROLES,
  RunStatusSchema,
  StopReasonSchema,
  TASK_KINDS,
  TASK_MODELS,
  TASK_STAGES,
  type ModelUsage,
} from '@jarvis/shared';
import { sql, type SQL } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// Drizzle row types never leave infrastructure/db: every repository maps rows to domain types.

const time = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** `"column" in ('a', 'b')` with the values inlined, because a CHECK cannot take bind parameters. */
const oneOf = (column: string, values: readonly string[]): SQL =>
  sql.raw(`"${column}" in (${values.map((v) => `'${v}'`).join(', ')})`);

/** Backs `TaskRepository.nextId()` (`T-<n>`). A sequence never hands out a value twice, even after a rollback. */
export const taskIds = pgSequence('task_ids');

export const threads = pgTable('threads', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  createdAt: time('created_at').notNull(),
  updatedAt: time('updated_at').notNull(),
  archivedAt: time('archived_at'),
});

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    /** Insertion order; breaks ties between rows with the same timestamp, like the in-memory fake. */
    ord: bigserial('ord', { mode: 'number' }).notNull(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id),
    title: text('title').notNull(),
    /** ADR-0018: `build` or `ui_check`; decides which stage transitions are legal. */
    kind: text('kind').notNull().default('build'),
    stage: text('stage').notNull(),
    resumeStage: text('resume_stage'),
    branch: text('branch').notNull(),
    prNumber: integer('pr_number'),
    prUrl: text('pr_url'),
    checkRetries: integer('check_retries').notNull().default(0),
    ciFixRounds: integer('ci_fix_rounds').notNull().default(0),
    reviewRounds: integer('review_rounds').notNull().default(0),
    /** Deliberately no FK: the task row exists before its worker session (sessions.task_id points back). */
    workerSessionId: text('worker_session_id'),
    startedAt: time('started_at').notNull(),
    updatedAt: time('updated_at').notNull(),
    reason: text('reason'),
    /** ADR-0012: the repo this task's worktree is created in, besides the configured default. */
    targetRepoOwner: text('target_repo_owner'),
    targetRepoName: text('target_repo_name'),
    /** The owner put the task on hold: no worker run starts until it is resumed. */
    held: boolean('held').notNull().default(false),
    /** A `claude --model` alias the owner chose; null means `models.worker`. */
    model: text('model'),
  },
  (t) => [
    check('tasks_kind_check', oneOf('kind', TASK_KINDS)),
    check('tasks_stage_check', oneOf('stage', TASK_STAGES)),
    check('tasks_model_check', sql`${t.model} is null or ${oneOf('model', TASK_MODELS)}`),
    check(
      'tasks_resume_stage_check',
      sql`${t.resumeStage} is null or ${oneOf('resume_stage', TASK_STAGES)}`,
    ),
    index('tasks_thread_idx').on(t.threadId),
    index('tasks_stage_idx').on(t.stage),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    ord: bigserial('ord', { mode: 'number' }).notNull(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id),
    taskId: text('task_id').references(() => tasks.id),
    kind: text('kind').notNull(),
    body: jsonb('body').$type<Record<string, unknown>>().notNull(),
    at: time('at').notNull(),
    /** Cards only; one answer, set once by the domain. */
    answer: jsonb('answer').$type<Record<string, unknown>>(),
    answeredAt: time('answered_at'),
  },
  (t) => [
    check('messages_kind_check', oneOf('kind', MessageKindSchema.options)),
    index('messages_thread_at_idx').on(t.threadId, t.at),
    index('messages_task_idx').on(t.taskId),
  ],
);

/** The append-only task journal (ADR-0008). A trigger rejects UPDATE and DELETE (see the hand-written migration). */
export const taskEvents = pgTable(
  'task_events',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    type: text('type').notNull(),
    at: time('at').notNull(),
    actor: text('actor').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    check('task_events_actor_check', oneOf('actor', ['system', 'agent', 'owner'])),
    index('task_events_task_seq_idx').on(t.taskId, t.seq),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    role: text('role').notNull(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id),
    taskId: text('task_id').references(() => tasks.id),
    claudeSessionId: text('claude_session_id'),
  },
  (t) => [
    check('sessions_role_check', oneOf('role', ROLES)),
    index('sessions_thread_role_idx').on(t.threadId, t.role),
  ],
);

export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    ord: bigserial('ord', { mode: 'number' }).notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    role: text('role').notNull(),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id),
    taskId: text('task_id').references(() => tasks.id),
    status: text('status').notNull(),
    startedAt: time('started_at').notNull(),
    finishedAt: time('finished_at'),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    turns: integer('turns').notNull().default(0),
    tokensInput: bigint('tokens_input', { mode: 'number' }).notNull().default(0),
    tokensOutput: bigint('tokens_output', { mode: 'number' }).notNull().default(0),
    tokensCacheRead: bigint('tokens_cache_read', { mode: 'number' }).notNull().default(0),
    tokensCacheWrite: bigint('tokens_cache_write', { mode: 'number' }).notNull().default(0),
    // Jarvis's run-level ending (see `Run.stopReason`); unrelated to the CLI's `stop_reason` (model-level).
    stopReason: text('stop_reason'),
    modelUsage: jsonb('model_usage').$type<ModelUsage>().notNull().default({}),
    exitCode: integer('exit_code'),
    error: text('error'),
  },
  (t) => [
    check('runs_role_check', oneOf('role', ROLES)),
    check('runs_status_check', oneOf('status', RunStatusSchema.options)),
    check(
      'runs_stop_reason_check',
      sql`${t.stopReason} is null or ${oneOf('stop_reason', StopReasonSchema.options)}`,
    ),
    index('runs_task_idx').on(t.taskId),
    index('runs_status_idx').on(t.status),
    index('runs_started_at_idx').on(t.startedAt),
    index('runs_thread_idx').on(t.threadId),
  ],
);

/** Normalised stream-json events of a run (ADR-0003). Append-only, like the journal. */
export const runEvents = pgTable(
  'run_events',
  {
    /** Global arrival order (bigserial). */
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    /** The run's own counter: 0, 1, 2, ... (the `seq` of `RunEvent`). Assigned under a per-run lock. */
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    parentToolUseId: text('parent_tool_use_id'),
    at: time('at').notNull(),
  },
  (t) => [uniqueIndex('run_events_run_seq_idx').on(t.runId, t.seq)],
);

export const permissionRequests = pgTable(
  'permission_requests',
  {
    id: text('id').primaryKey(),
    ord: bigserial('ord', { mode: 'number' }).notNull(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id),
    threadId: text('thread_id')
      .notNull()
      .references(() => threads.id),
    taskId: text('task_id').references(() => tasks.id),
    tool: text('tool').notNull(),
    description: text('description').notNull(),
    input: jsonb('input').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull(),
    requestedAt: time('requested_at').notNull(),
    expiresAt: time('expires_at').notNull(),
    decidedAt: time('decided_at'),
  },
  (t) => [
    check(
      'permission_requests_status_check',
      oneOf('status', ['pending', 'allow', 'deny', 'timeout']),
    ),
    index('permission_requests_status_idx').on(t.status, t.requestedAt),
    index('permission_requests_run_idx').on(t.runId),
  ],
);

export const watches = pgTable('watches', {
  taskId: text('task_id')
    .primaryKey()
    .references(() => tasks.id),
  prNumber: integer('pr_number').notNull(),
  state: jsonb('state').$type<unknown>(),
  lastCheckedAt: time('last_checked_at'),
  summary: jsonb('summary').$type<unknown>(),
  lastGreen: jsonb('last_green').$type<unknown>(),
  rerunHeadSha: text('rerun_head_sha'),
});

/** The owner's "reset today's usage" moments (LIM-04). Append-only; the latest one counts. */
export const budgetResets = pgTable('budget_resets', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  at: time('at').notNull(),
});
