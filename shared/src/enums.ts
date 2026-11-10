import { z } from 'zod';

export const TaskStageSchema = z.enum([
  'Intake',
  'Context',
  'Spec Review',
  'Implementing',
  'Verifying',
  'Reviewing',
  'PR Open',
  'Fixing',
  'Done',
  'Blocked',
  'Failed',
  'Cancelled',
]);
export type TaskStage = z.infer<typeof TaskStageSchema>;
export const TASK_STAGES = TaskStageSchema.options;

/**
 * ADR-0018: what a task is for. `build` writes code and opens a PR; `ui_check` only looks at a PR
 * that already exists. The kind decides which stage transitions are legal, so a `build` task can
 * never skip `Spec Review` through the short path a check needs.
 */
export const TaskKindSchema = z.enum(['build', 'ui_check']);
export type TaskKind = z.infer<typeof TaskKindSchema>;
export const TASK_KINDS = TaskKindSchema.options;

export const TERMINAL_STAGES = [
  'Done',
  'Failed',
  'Cancelled',
] as const satisfies readonly TaskStage[];

export const RoleSchema = z.enum(['dispatcher', 'worker']);
export type Role = z.infer<typeof RoleSchema>;
export const ROLES = RoleSchema.options;

export const SubagentNameSchema = z.enum([
  'context-researcher',
  'plan-verifier',
  'implementer',
  'reviewer',
]);
export type SubagentName = z.infer<typeof SubagentNameSchema>;

export const RunStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'stopped',
  'limit_reached',
  'interrupted',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** Why a run ended; finer than `RunStatus`, which folds three reasons into `limit_reached`. */
export const StopReasonSchema = z.enum([
  'success',
  'max_turns',
  'budget',
  'error',
  'rate_limited',
  'cancelled',
  'killed',
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

export const MessageKindSchema = z.enum([
  'owner',
  'jarvis',
  'status',
  'decision',
  'question',
  'permission',
  'result',
  'system',
]);
export type MessageKind = z.infer<typeof MessageKindSchema>;

export const WaitingForSchema = z.enum(['owner', 'ci', 'review', 'worker slot', '—']);
export type WaitingFor = z.infer<typeof WaitingForSchema>;

export const RunEventKindSchema = z.enum([
  'text',
  'tool_use',
  'tool_result',
  'permission',
  'system',
  'result',
  'error',
]);
export type RunEventKind = z.infer<typeof RunEventKindSchema>;

/**
 * The models a task can be switched to, as `claude --model` aliases (the CLI maps each to its
 * current model). `null` on a task means the configured `models.worker`.
 */
export const TaskModelSchema = z.enum(['fable', 'opus', 'sonnet', 'haiku']);
export type TaskModel = z.infer<typeof TaskModelSchema>;
export const TASK_MODELS = TaskModelSchema.options;
