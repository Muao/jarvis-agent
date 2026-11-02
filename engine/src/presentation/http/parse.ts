import type { ZodType } from 'zod';
import { RequestValidationError, type ValidationDetail } from './errors.js';

/** Validates a request part with a shared schema; failure becomes a 400 with the offending paths. */
export function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const details: ValidationDetail[] = [];
  for (const issue of result.error.issues) {
    const base = issue.path.map(String);
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        details.push({ path: [...base, key].join('.'), message: 'Unknown field.' });
      }
    } else {
      details.push({ path: base.join('.'), message: issue.message });
    }
  }
  throw new RequestValidationError(details);
}
