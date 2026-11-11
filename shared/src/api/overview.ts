import { z } from 'zod';
import { IsoDateSchema, TaskIdSchema } from '../common.js';
import { TaskStageSchema } from '../enums.js';
import { CheckStatusSchema, ReviewStateSchema } from './tasks.js';

export const UsageDtoSchema = z.object({
  /** Tokens since local midnight or the last reset: input, output, cache writes and cache reads. */
  todayTokens: z.number().int().min(0),
  budgetTokens: z.number().int().positive(),
  resetsAt: IsoDateSchema,
  /** Daily budget reached: new runs wait (LIM-04). */
  paused: z.boolean(),
});
export type UsageDto = z.infer<typeof UsageDtoSchema>;

const WorkerSlotSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('free') }),
  z.object({
    state: z.enum(['busy', 'stalled', 'waiting_for_permission', 'paused']),
    taskId: TaskIdSchema,
    title: z.string(),
    stage: TaskStageSchema,
    action: z.string().nullable(),
    startedAt: IsoDateSchema,
    sessionId: z.string(),
    runCostUsd: z.number().min(0),
  }),
]);

/** `GET /api/overview` */
export const OverviewDtoSchema = z.object({
  usage: UsageDtoSchema,
  dispatcher: z.object({
    status: z.enum(['idle', 'running', 'waiting_for_permission', 'error']),
    action: z.string().nullable(),
    runningSince: IsoDateSchema.nullable(),
    sessionId: z.string().nullable(),
  }),
  workers: z.array(WorkerSlotSchema),
  queue: z.array(
    z.object({
      taskId: TaskIdSchema,
      what: z.enum(['new_task', 'ci_event', 'owner_reply']),
      since: IsoDateSchema,
      position: z.number().int().min(1),
    }),
  ),
  watching: z.array(
    z.object({
      taskId: TaskIdSchema,
      stage: TaskStageSchema,
      prUrl: z.url().nullable(),
      ci: CheckStatusSchema.nullable(),
      review: ReviewStateSchema.nullable(),
      lastCheckedAt: IsoDateSchema.nullable(),
      nextCheckAt: IsoDateSchema.nullable(),
    }),
  ),
  waitingForOwner: z.number().int().min(0),
  prsOpen: z.number().int().min(0),
  events: z.array(
    z.object({
      id: z.string(),
      at: IsoDateSchema,
      taskId: TaskIdSchema.nullable(),
      type: z.enum(['stage', 'ci', 'review', 'permission', 'error']),
      text: z.string(),
    }),
  ),
});
export type OverviewDto = z.infer<typeof OverviewDtoSchema>;
