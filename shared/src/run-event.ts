import { z } from 'zod';
import { IsoDateSchema, TokenUsageSchema } from './common.js';

const common = {
  seq: z.number().int().min(0),
  runId: z.string().min(1),
  at: IsoDateSchema,
  /** Set on events produced inside a subagent; points at the parent `Task` tool call. */
  parentToolUseId: z.string().min(1).optional(),
};

const Json = z.record(z.string(), z.unknown());

/** A normalised stream-json line (ADR-0004). Stored in `run_events` and pushed over SSE. */
export const RunEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('text'), payload: z.object({ text: z.string() }) }),
  z.object({
    ...common,
    kind: z.literal('tool_use'),
    payload: z.object({ toolUseId: z.string().min(1), name: z.string().min(1), input: Json }),
  }),
  z.object({
    ...common,
    kind: z.literal('tool_result'),
    payload: z.object({ toolUseId: z.string().min(1), content: z.string(), isError: z.boolean() }),
  }),
  z.object({
    ...common,
    kind: z.literal('permission'),
    payload: z.object({
      permissionId: z.string().min(1),
      toolName: z.string().min(1),
      decision: z.enum(['pending', 'allow', 'deny', 'timeout']),
    }),
  }),
  z.object({
    ...common,
    kind: z.literal('system'),
    payload: z.object({ subtype: z.string().min(1), message: z.string().optional() }),
  }),
  z.object({
    ...common,
    kind: z.literal('result'),
    payload: z.object({
      subtype: z.string().min(1),
      isError: z.boolean(),
      turns: z.number().int().min(0),
      durationMs: z.number().int().min(0),
      costUsd: z.number().min(0),
      usage: TokenUsageSchema,
      text: z.string().optional(),
    }),
  }),
  z.object({ ...common, kind: z.literal('error'), payload: z.object({ message: z.string() }) }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
