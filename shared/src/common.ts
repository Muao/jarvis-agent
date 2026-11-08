import { z } from 'zod';

/** Dates cross the wire as ISO 8601 strings. */
export const IsoDateSchema = z.iso.datetime();

/** Task ids are `T-<n>`. */
export const TaskIdSchema = z.string().regex(/^T-\d+$/, 'Expected a task id like T-12');

/** A retry/round counter shown as `used/max`. */
export const CounterSchema = z.object({
  used: z.number().int().min(0),
  max: z.number().int().min(0),
});
export type Counter = z.infer<typeof CounterSchema>;

export const TokenUsageSchema = z.object({
  input: z.number().int().min(0),
  output: z.number().int().min(0),
  cacheRead: z.number().int().min(0),
  cacheWrite: z.number().int().min(0),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/** Per-model usage of one run: the model id maps to its tokens and notional cost. */
export const ModelUsageSchema = z.record(
  z.string(),
  TokenUsageSchema.extend({ costUsd: z.number().min(0) }),
);
export type ModelUsage = z.infer<typeof ModelUsageSchema>;

export const TextBodySchema = z.strictObject({ text: z.string().min(1) });
export type TextBody = z.infer<typeof TextBodySchema>;
