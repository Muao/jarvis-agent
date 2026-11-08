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
