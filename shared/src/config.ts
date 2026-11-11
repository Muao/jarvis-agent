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
/** ADR-0027: the claude.ai account connectors a run may be given, read-only. */
export const ClaudeAiConnectorSchema = z.enum(['notion', 'slack', 'google_docs', 'google_drive']);
export type ClaudeAiConnector = z.infer<typeof ClaudeAiConnectorSchema>;

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
      /** ADR-0012: Jarvis's own repository may be a task target; the owner's PR review is the gate. */
      allowSelf: z.boolean().default(false),
    })
    .prefault({}),
  limits: z
    .strictObject({
      maxConcurrentWorkers: positiveInt(1),
      checkRetries: positiveInt(3),
      /** ADR-0022: per check command run by the engine before it opens the PR. */
      checkTimeoutMinutes: positiveInt(15),
      ciFixRounds: positiveInt(2),
      reviewRounds: positiveInt(3),
      taskTimeoutMinutes: positiveInt(60),
      maxTurnsPerRun: positiveInt(60),
      maxBudgetUsdPerRun: positiveNumber(3),
      /**
       * Tokens all runs may use between two local midnights (input, output, cache writes and cache
       * reads together); new runs wait once it is reached. Tokens, not dollars: on a subscription
       * the CLI's dollar figure is notional and is reported per session, not per run.
       */
      dailyBudgetTokens: positiveInt(50_000_000),
      /**
       * Comments the agent may post or replace on pull requests per local day, across all tasks.
       * The agent writes them without asking (`ui.autoApproveComments`); this count is the brake.
       */
      maxPrCommentsPerDay: positiveInt(100),
      /** Commits the engine may push per local day, across all tasks. */
      maxCommitsPerDay: positiveInt(100),
      permissionTimeoutMinutes: positiveInt(30),
      stallMinutes: positiveInt(10),
      /** The first chat update of a run, so the owner is not left wondering for a whole interval. */
      firstProgressUpdateSeconds: positiveInt(30),
      progressUpdateMinutes: positiveInt(1),
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
      /**
       * ADR-0027: connectors of the owner's claude.ai account that runs may read. Empty keeps
       * every run on `--strict-mcp-config`, with no account connector in reach.
       */
      claudeAi: z.array(ClaudeAiConnectorSchema).default([]),
    })
    .prefault({}),
  engine: z
    .strictObject({
      port: z.number().int().min(1).max(65535).default(4310),
      claudeBinary: z.string().min(1).default('claude'),
    })
    .prefault({}),
  /**
   * ADR-0014, ADR-0026: the UI check — an engine-leased environment in disposable containers plus
   * Playwright MCP, driven by the `ui-tester` subagent. Only
   * generic knobs live here: how a particular project is brought up is worked out by the agent at
   * runtime and never configured.
   */
  ui: z
    .strictObject({
      /** On by default: the UI check is a step of the workflow. False is the owner's off switch. */
      enabled: z.boolean().default(true),
      /** The image a plan's commands run in when the plan names none. */
      defaultImage: z.string().min(1).default('node:22-bookworm'),
      /** How long one step may take to become ready (a service's port, the app's page). */
      readyTimeoutSeconds: positiveInt(90),
      /** How long one `prepare` command or one image pull may run. */
      prepareTimeoutSeconds: positiveInt(600),
      /** How many plans one run may try before it must report that the app does not come up. */
      maxStartAttempts: positiveInt(3),
      /** How long one environment may live before the engine removes its containers. */
      leaseMinutes: positiveInt(15),
      maxScenarios: positiveInt(8),
      maxScreenshots: positiveInt(12),
      maxImageMb: positiveNumber(5),
      /** ADR-0014: false leaves screenshot file names in the PR instead of inline images. */
      attachToPr: z.boolean().default(true),
      /**
       * ADR-0018, amended: true (the default) posts and replaces PR comments without a permission
       * card — the agent is meant to work on its own, and `limits.maxPrCommentsPerDay` bounds how
       * much it can write. False brings the card back for every comment.
       */
      autoApproveComments: z.boolean().default(true),
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
  /** ADR-0021: the self-curating memory under `## Learned` in `USER.md`. */
  memory: z
    .strictObject({
      /** A worker run's memory block is cut here; the file itself is never cut. */
      softCapChars: positiveInt(4000),
      /** Copies of `USER.md` kept in `~/.jarvis/backups/` before `forget` and `merge_insights`. */
      backupsKept: positiveInt(20),
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

/**
 * Keys that left the config: the target-specific ones (ADR-0026) and the dollar budget, replaced by
 * `limits.dailyBudgetTokens`. A file that still has them loads without them.
 */
export const RETIRED_CONFIG_KEYS: readonly string[] = [
  'limits.dailyBudgetUsd',
  'ui.devCommand',
  'ui.baseUrl',
  'ui.readyPath',
  'ui.allowedOrigins',
  'ui.env',
];

/**
 * Removes `RETIRED_CONFIG_KEYS` from a raw config object, in place, and returns the ones it found —
 * so an engine deployed over an older config starts, and says what it ignored.
 */
export function dropRetiredConfigKeys(raw: unknown): string[] {
  const dropped: string[] = [];
  if (typeof raw !== 'object' || raw === null) return dropped;
  for (const key of RETIRED_CONFIG_KEYS) {
    const [section, name] = key.split('.') as [string, string];
    const holder = (raw as Record<string, unknown>)[section];
    if (typeof holder === 'object' && holder !== null && name in holder) {
      delete (holder as Record<string, unknown>)[name];
      dropped.push(key);
    }
  }
  return dropped;
}

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
