import { z } from 'zod';

const positiveInt = (fallback: number) => z.number().int().min(1).default(fallback);
const positiveNumber = (fallback: number) => z.number().positive().default(fallback);
const modelName = z.string().min(1).default('sonnet');

const loopbackHosts = new Set(['127.0.0.1', 'localhost']);

const isLoopbackUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && loopbackHosts.has(url.hostname)
    );
  } catch {
    return false;
  }
};

/** An http(s) URL whose host is 127.0.0.1 or localhost; `what` names it in the error. */
const loopbackUrlOf = (what: string) =>
  z.string().refine(isLoopbackUrl, {
    message: `must be an http(s) URL on 127.0.0.1 or localhost (${what})`,
  });

/** The local Alloy receiver (ADR-0016). */
const loopbackUrl = loopbackUrlOf('the local Alloy receiver');

/**
 * `~/.jarvis/jarvis.config.json` (ADR-0005). Strict everywhere: a mistyped limit
 * or a stray key (for instance a token) is an error, never silently ignored.
 */
export const JarvisConfigSchema = z.strictObject({
  repo: z.strictObject({
    path: z.string().min(1),
    remote: z.string().min(1).default('origin'),
    baseBranch: z.string().min(1).default('main'),
  }),
  /** ADR-0012: repos a task may target besides `repo` (the default), by clone-on-demand. */
  repos: z
    .strictObject({
      allow: z
        .array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must look like "owner/name"'))
        .default([]),
      allowOwnerRepos: z.boolean().default(false),
    })
    .prefault({}),
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
      progressUpdateMinutes: positiveInt(2),
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
  /**
   * ADR-0014: the UI check the worker runs in `Reviewing` — an engine-leased dev server plus
   * Playwright MCP, driven by the `ui-tester` subagent. Off until the owner turns it on.
   */
  ui: z
    .strictObject({
      enabled: z.boolean().default(false),
      /** Run in the task's worktree by the engine, never chosen by a model. */
      devCommand: z.string().min(1).default('pnpm dev'),
      baseUrl: loopbackUrlOf("the agent's dev server").default('http://127.0.0.1:5173'),
      readyPath: z.string().startsWith('/').default('/'),
      readyTimeoutSeconds: positiveInt(90),
      /** How long one dev server may live before the engine kills its process tree. */
      leaseMinutes: positiveInt(15),
      maxScenarios: positiveInt(8),
      maxScreenshots: positiveInt(12),
      maxImageMb: positiveNumber(5),
      /** ADR-0014: false leaves screenshot file names in the PR instead of inline images. */
      attachToPr: z.boolean().default(true),
      /** Chromium cannot use user namespaces inside the runtime container (ADR-0016). */
      noSandbox: z.boolean().default(false),
      /** A diff touching none of these globs is not a UI change. */
      paths: z
        .array(z.string().min(1))
        .default([
          '**/*.tsx',
          '**/*.jsx',
          '**/*.vue',
          '**/*.svelte',
          '**/*.css',
          '**/*.scss',
          '**/*.html',
        ]),
    })
    .prefault({}),
  /** Claude Code's own OTel export (ADR-0016). Off by default; the credential lives in `.env`, never here. */
  telemetry: z
    .strictObject({
      enabled: z.boolean().default(false),
      otlpEndpoint: loopbackUrl.default('http://127.0.0.1:4318'),
      protocol: z.enum(['http/protobuf']).default('http/protobuf'),
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
