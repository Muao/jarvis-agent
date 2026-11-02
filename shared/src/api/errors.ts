import { z } from 'zod';

/** Body of every non-2xx response. `code` is the stable `DomainError` code. */
export const ApiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
