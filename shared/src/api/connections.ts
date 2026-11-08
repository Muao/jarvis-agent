import { z } from 'zod';
import { IsoDateSchema } from '../common.js';

export const ConnectionIdSchema = z.enum([
  'claude',
  'github',
  'notion',
  'google_docs',
  'claude_design',
  'slack',
]);
export type ConnectionId = z.infer<typeof ConnectionIdSchema>;

export const ConnectionDtoSchema = z.object({
  id: ConnectionIdSchema,
  status: z.enum(['ok', 'warning', 'failed', 'checking', 'not_configured', 'disabled']),
  summary: z.string(),
  /** Display pairs such as `Account: jarvis-bot`; never a token (SEC-04). */
  details: z.array(z.object({ label: z.string(), value: z.string() })),
  checkedAt: IsoDateSchema.nullable(),
});
export type ConnectionDto = z.infer<typeof ConnectionDtoSchema>;

/** `GET /api/connections` */
export const ConnectionsDtoSchema = z.object({
  /** `ANTHROPIC_API_KEY` or a similar variable is set: the CLI would bill the API (SEC-05). */
  billingEnvDetected: z.boolean(),
  /** `true`: logged in with the subscription (`claude.ai`); `false`: logged in another way; `null`: unknown or not logged in. */
  claudeSubscription: z.boolean().nullable(),
  connections: z.array(ConnectionDtoSchema),
});
export type ConnectionsDto = z.infer<typeof ConnectionsDtoSchema>;
