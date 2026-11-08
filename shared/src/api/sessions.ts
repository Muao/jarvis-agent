import { z } from 'zod';
import {
  IsoDateSchema,
  ModelUsageSchema,
  TaskIdSchema,
  TextBodySchema,
  TokenUsageSchema,
} from '../common.js';
import { RoleSchema, RunStatusSchema, StopReasonSchema, TaskStageSchema } from '../enums.js';
import { RunEventSchema } from '../run-event.js';

export const SessionStatusSchema = z.enum([
  'running',
  'idle',
  'waiting_for_permission',
  'stopped',
  'error',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/** One `claude` process. */
export const RunDtoSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  taskId: TaskIdSchema.nullable(),
  role: RoleSchema,
  stage: TaskStageSchema.nullable(),
  status: RunStatusSchema,
  startedAt: IsoDateSchema,
  endedAt: IsoDateSchema.nullable(),
  usage: TokenUsageSchema,
  /** Notional: `total_cost_usd` from the CLI. */
  costUsd: z.number().min(0),
  turns: z.number().int().min(0),
  maxTurns: z.number().int().min(1),
  stopReason: StopReasonSchema.nullable(),
  modelUsage: ModelUsageSchema,
  exitCode: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type RunDto = z.infer<typeof RunDtoSchema>;

/** `GET /api/sessions/:id` */
export const SessionDtoSchema = z.object({
  id: z.string(),
  role: RoleSchema,
  taskId: TaskIdSchema.nullable(),
  threadId: z.string(),
  model: z.string(),
  status: SessionStatusSchema,
  claudeSessionId: z.string().nullable(),
  /** No events for longer than `limits.stallMinutes` (DSP-09). */
  stalled: z.boolean(),
  runs: z.array(RunDtoSchema),
});
export type SessionDto = z.infer<typeof SessionDtoSchema>;

/** `GET /api/runs/:id/events?afterSeq=` — events with `seq` greater than `afterSeq`. */
export const RunEventsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(-1).optional(),
});
export type RunEventsQuery = z.infer<typeof RunEventsQuerySchema>;

export const RunEventsDtoSchema = z.object({ events: z.array(RunEventSchema) });
export type RunEventsDto = z.infer<typeof RunEventsDtoSchema>;

/** `POST /api/sessions/:id/messages` */
export const SendSessionMessageBodySchema = TextBodySchema;
export type SendSessionMessageBody = z.infer<typeof SendSessionMessageBodySchema>;

export const SendSessionMessageResultSchema = z.object({
  delivery: z.enum(['queued', 'delivered']),
});
export type SendSessionMessageResult = z.infer<typeof SendSessionMessageResultSchema>;
