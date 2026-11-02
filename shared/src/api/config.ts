import { z } from 'zod';
import { IsoDateSchema, TaskIdSchema } from '../common.js';
import { JarvisConfigSchema } from '../config.js';
import { RoleSchema } from '../enums.js';
import { UsageDtoSchema } from './overview.js';

const ProfileFileSchema = z.object({
  path: z.string(),
  content: z.string().nullable(),
  modifiedAt: IsoDateSchema.nullable(),
});

/** `GET /api/config` — read-only view; values change in the config file. */
export const ConfigDtoSchema = z.discriminatedUnion('valid', [
  z.object({
    valid: z.literal(true),
    path: z.string(),
    loadedAt: IsoDateSchema,
    config: JarvisConfigSchema,
    usage: UsageDtoSchema.extend({
      byRole: z.record(RoleSchema, z.number().min(0)),
      byTask: z.array(z.object({ taskId: TaskIdSchema, costUsd: z.number().min(0) })),
    }),
    /** Commands read from the target repo's AGENTS.md (CON-04). */
    repository: z.object({
      checkCommands: z.array(z.string()),
      devCommand: z.string().nullable(),
      warning: z.string().nullable(),
    }),
    profile: z.object({ soul: ProfileFileSchema, user: ProfileFileSchema }),
  }),
  z.object({
    valid: z.literal(false),
    path: z.string(),
    /** `path: message` lines from `formatConfigError`. */
    errors: z.array(z.string()),
  }),
]);
export type ConfigDto = z.infer<typeof ConfigDtoSchema>;
