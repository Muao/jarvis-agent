import { z } from 'zod';

/** `GET /api/health`: what systemd and monitoring read. `claude` is the last cached probe, never a fresh one. */
export const HealthSchema = z.object({
  status: z.enum(['ok', 'degraded', 'failed']),
  uptimeSeconds: z.number().nonnegative(),
  database: z.enum(['ok', 'failed']),
  claude: z.enum(['ok', 'warning', 'failed', 'unknown']),
  activeRuns: z.number().int().nonnegative(),
  version: z.string(),
});
export type Health = z.infer<typeof HealthSchema>;
