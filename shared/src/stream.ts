import { z } from 'zod';
import { RunEventSchema } from './run-event.js';

const entity = z.string().min(1);

/** SSE notifications on `GET /api/stream`. The web patches or invalidates Query caches from them. */
export const StreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thread'), id: entity }),
  z.object({ type: z.literal('task'), id: entity }),
  z.object({ type: z.literal('run'), id: entity }),
  /** `id` is the run id; `data` is the new event. */
  z.object({ type: z.literal('run_event'), id: entity, data: RunEventSchema }),
  z.object({ type: z.literal('overview') }),
  z.object({ type: z.literal('config') }),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;
