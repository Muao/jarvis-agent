import { z } from 'zod';
import { CounterSchema, IsoDateSchema, TaskIdSchema } from '../common.js';
import { TaskModelSchema, TaskStageSchema, WaitingForSchema, type TaskStage } from '../enums.js';
import { RunDtoSchema } from './sessions.js';

export const ArtifactNameSchema = z.enum([
  'context.md',
  'spec.md',
  'plan.md',
  'tasks.md',
  'result.md',
]);
export type ArtifactName = z.infer<typeof ArtifactNameSchema>;

/**
 * Stages in which `Retry stage` is accepted: `Failed` (owner retry) and the stages with a worker.
 * Mirrors the engine's `RetryStage`; the UI enables the button for exactly these.
 */
export const RETRYABLE_STAGES: readonly TaskStage[] = [
  'Failed',
  'Intake',
  'Context',
  'Implementing',
  'Verifying',
  'Reviewing',
  'Fixing',
];

export const CheckStatusSchema = z.enum(['queued', 'running', 'passed', 'failed', 'skipped']);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const ReviewStateSchema = z.enum(['pending', 'changes_requested', 'approved']);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

/** Row of `GET /api/tasks`. */
export const TaskDtoSchema = z.object({
  id: TaskIdSchema,
  threadId: z.string(),
  title: z.string(),
  stage: TaskStageSchema,
  /** The task's worker is running right now. In `PR Open` the UI shows it as `Thinking`. */
  working: z.boolean(),
  /** The owner put the task on hold: no worker run starts until it is resumed. */
  held: z.boolean(),
  /** The model the task's worker runs on; null means the configured `models.worker`. */
  model: TaskModelSchema.nullable(),
  waitingFor: WaitingForSchema,
  branch: z.string(),
  prNumber: z.number().int().nullable(),
  prUrl: z.url().nullable(),
  /** Summary of the checks on the current head commit; null before a PR exists. */
  ci: CheckStatusSchema.nullable(),
  runCount: z.number().int().min(0),
  costUsd: z.number().min(0),
  /** Tokens of every run of the task: input, output, cache writes and cache reads together. */
  tokens: z.number().int().min(0),
  updatedAt: IsoDateSchema,
});
export type TaskDto = z.infer<typeof TaskDtoSchema>;

export const StageSpanSchema = z.object({
  stage: TaskStageSchema,
  enteredAt: IsoDateSchema,
  exitedAt: IsoDateSchema.nullable(),
  /** Why a Blocked / Failed / Cancelled stage was entered. */
  reason: z.string().nullable(),
});

export const CheckDtoSchema = z.object({
  name: z.string(),
  status: CheckStatusSchema,
  durationMs: z.number().int().min(0).nullable(),
  url: z.url().nullable(),
});

export const ReviewCommentDtoSchema = z.object({
  id: z.string(),
  author: z.string(),
  body: z.string(),
  /** `ignored` = author is not on the allowlist or is the bot (CI-06). */
  handling: z.enum(['pending', 'handled', 'ignored']),
});

export const PullRequestDtoSchema = z.object({
  number: z.number().int(),
  url: z.url(),
  headSha: z.string(),
  checks: z.array(CheckDtoSchema),
  /** Checks of earlier commits, collapsed in the UI. */
  earlierChecks: z.array(CheckDtoSchema),
  review: ReviewStateSchema,
  comments: z.array(ReviewCommentDtoSchema),
  lastCheckedAt: IsoDateSchema.nullable(),
});

export const JournalEntryDtoSchema = z.object({
  id: z.string(),
  at: IsoDateSchema,
  type: z.string(),
  text: z.string(),
  by: z.enum(['system', 'agent', 'owner']),
});

/** `GET /api/tasks/:id` */
export const TaskDetailDtoSchema = TaskDtoSchema.extend({
  startedAt: IsoDateSchema,
  /** Present for Blocked and Failed. */
  reason: z.string().nullable(),
  counters: z.object({ checks: CounterSchema, ciFixes: CounterSchema, reviews: CounterSchema }),
  stages: z.array(StageSpanSchema),
  pullRequest: PullRequestDtoSchema.nullable(),
  runs: z.array(RunDtoSchema),
  journal: z.array(JournalEntryDtoSchema),
  /** Which artifact files exist yet. */
  artifacts: z.array(z.object({ name: ArtifactNameSchema, exists: z.boolean() })),
  /** Session of the current worker, for the console link. */
  workerSessionId: z.string().nullable(),
});
export type TaskDetailDto = z.infer<typeof TaskDetailDtoSchema>;

/** `GET /api/tasks/:id/artifacts/:name` */
export const ArtifactDtoSchema = z.object({
  name: ArtifactNameSchema,
  exists: z.boolean(),
  content: z.string().nullable(),
  updatedAt: IsoDateSchema.nullable(),
});
export type ArtifactDto = z.infer<typeof ArtifactDtoSchema>;

/** `PUT /api/tasks/:id/model`: the model the task's worker runs on from its next run. */
export const SetTaskModelBodySchema = z.strictObject({ model: TaskModelSchema });
export type SetTaskModelBody = z.infer<typeof SetTaskModelBodySchema>;
