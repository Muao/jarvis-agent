import { z } from 'zod';

const positiveInt = (fallback: number) => z.number().int().min(1).default(fallback);
const positiveNumber = (fallback: number) => z.number().positive().default(fallback);
const modelName = z.string().min(1).default('sonnet');

/**
 * `~/.jarvis/jarvis.config.json` (ADR-0006). Strict everywhere: a mistyped limit
 * or a stray key (for instance a token) is an error, never silently ignored.
 */
export const JarvisConfigSchema = z.strictObject({
  repo: z.strictObject({
    path: z.string().min(1),
    remote: z.string().min(1).default('origin'),
    baseBranch: z.string().min(1).default('main'),
  }),
  limits: z
    .strictObject({
      maxConcurrentWorkers: positiveInt(1),
      checkRetries: positiveInt(3),
      ciFixRounds: positiveInt(2),
      reviewRounds: positiveInt(3),
      taskTimeoutMinutes: positiveInt(60),
      maxTurnsPerRun: positiveInt(60),
      maxBudgetUsdPerRun: positiveNumber(3),
      dailyBudgetUsd: positiveNumber(20),
      permissionTimeoutMinutes: positiveInt(30),
      stallMinutes: positiveInt(10),
    })
    .prefault({}),
  watch: z.strictObject({ pollSeconds: positiveInt(60) }).prefault({}),
  models: z
    .strictObject({ dispatcher: modelName, worker: modelName, reviewer: modelName })
    .prefault({}),
  allowlist: z
    .strictObject({
      githubReviewers: z.array(z.string().min(1)).default([]),
      autoAllowedCommands: z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
  connectors: z
    .strictObject({
      notionRoot: z.string().min(1).optional(),
      googleFolder: z.string().min(1).optional(),
    })
    .prefault({}),
  engine: z
    .strictObject({
      port: z.number().int().min(1).max(65535).default(4310),
      claudeBinary: z.string().min(1).default('claude'),
    })
    .prefault({}),
});

export type JarvisConfig = z.output<typeof JarvisConfigSchema>;
export type JarvisConfigInput = z.input<typeof JarvisConfigSchema>;

/** One `path: message` line per issue (LIM-02). */
export function formatConfigError(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) =>
        `${issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)'}: ${issue.message}`,
    )
    .join('\n');
}
