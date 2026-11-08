import { z } from 'zod';
import { IsoDateSchema, TaskIdSchema, TokenUsageSchema } from '../common.js';
import { RoleSchema, TaskStageSchema } from '../enums.js';

/**
 * `GET /api/usage`: what runs cost over a window, grouped. Not `UsageDto` (overview.ts), which is the
 * "spent today against the daily budget" widget.
 */
export const USAGE_GROUPS = ['day', 'session', 'task', 'model'] as const;
export const UsageGroupBySchema = z.enum(USAGE_GROUPS);
export type UsageGroupBy = z.infer<typeof UsageGroupBySchema>;

/** The widest window a report may cover. */
export const USAGE_MAX_WINDOW_DAYS = 366;
/** The window when `from` and `to` are omitted: the last 7 days. */
export const USAGE_DEFAULT_WINDOW_DAYS = 7;

/** `from` is inclusive, `to` exclusive; both are optional ISO instants. `groupBy` defaults to `day`. */
export const UsageQuerySchema = z.strictObject({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  groupBy: UsageGroupBySchema.default('day'),
});
export type UsageQuery = z.infer<typeof UsageQuerySchema>;

const usageFigures = {
  /** Runs that started in the window, `running` ones included. */
  runs: z.number().int().min(0),
  costUsd: z.number().min(0),
  turns: z.number().int().min(0),
  tokens: TokenUsageSchema,
  /** Runs per ending; a run still going counts under `running`. */
  stopReasons: z.record(z.string(), z.number().int().min(0)),
  /** Finished runs only: `finishedAt - startedAt`. */
  durationMs: z.number().int().min(0),
};

export const UsageTotalSchema = z.object(usageFigures);
export type UsageTotal = z.infer<typeof UsageTotalSchema>;

export const UsageRowSchema = z.object({
  /** UTC date `YYYY-MM-DD` (day), session id, task id or model id. */
  key: z.string(),
  ...usageFigures,
  /** `session` rows. */
  role: RoleSchema.optional(),
  threadId: z.string().optional(),
  taskId: TaskIdSchema.nullable().optional(),
  /** `task` rows: `closed` once the task reached Done, Failed or Cancelled, otherwise `open`. */
  status: z.enum(['open', 'closed']).optional(),
  stage: TaskStageSchema.optional(),
});
export type UsageRow = z.infer<typeof UsageRowSchema>;

export const UsageReportSchema = z.object({
  from: IsoDateSchema,
  to: IsoDateSchema,
  groupBy: UsageGroupBySchema,
  rows: z.array(UsageRowSchema),
  /** Over every run in the window, whatever the grouping (a `task` report still counts task-less runs). */
  total: UsageTotalSchema,
});
export type UsageReport = z.infer<typeof UsageReportSchema>;
