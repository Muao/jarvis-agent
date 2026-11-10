import { join } from 'node:path';
import type { Role, TaskKind } from '@jarvis/shared';
import type { EnvSource } from '../config/index.js';

/**
 * The only variables a child `claude` inherits (ADR-0003, ADR-0015). Everything else, in particular
 * `ANTHROPIC_*`, `CLAUDE_CODE_USE_*`, `DATABASE_URL` and `SLACK_*`, is dropped by construction.
 * `CLAUDE_CONFIG_DIR` and `USER` select the owner's subscription login: without them the CLI falls
 * back to the default config dir, which may authenticate with an API key helper instead (SEC-05).
 */
const INHERITED = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'USER',
  'SHELL',
  'TMPDIR',
  'CLAUDE_CONFIG_DIR',
  // ADR-0014: Playwright MCP is a grandchild (engine -> claude -> MCP server); without this it
  // looks for Chromium in the default cache instead of where the runtime image installed it.
  'PLAYWRIGHT_BROWSERS_PATH',
  // The commit identity. A worker runs with GIT_CONFIG_GLOBAL=/dev/null (ADR-0022), so a global
  // `user.name` never reaches it; these set the author of its commits instead. Not credentials.
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const;

/**
 * Claude Code's own OTel export (ADR-0016). Present only when telemetry is on; the values are set
 * by Jarvis from its config and the run, never inherited. Credentials are not part of it: the child
 * exports to the local collector, which alone authenticates upstream.
 */
export interface ChildTelemetry {
  readonly enabled: boolean;
  readonly otlpEndpoint: string;
  readonly protocol: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly taskId?: string;
}

function telemetryEnv(role: Role, t: ChildTelemetry): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: t.protocol,
    OTEL_EXPORTER_OTLP_ENDPOINT: t.otlpEndpoint,
    // Prompt text never leaves the host; not configurable.
    OTEL_LOG_USER_PROMPTS: '0',
    OTEL_RESOURCE_ATTRIBUTES: [
      'service.name=jarvis-claude',
      `jarvis.role=${role}`,
      `jarvis.run_id=${t.runId}`,
      `jarvis.task_id=${t.taskId ?? '-'}`,
      `jarvis.session_id=${t.sessionId}`,
    ].join(','),
  };
}

/** Name of the empty `gh` config directory inside a worker's run directory. */
export const WORKER_GH_DIR = 'gh';

export function buildChildEnv(
  source: EnvSource,
  options: {
    readonly role: Role;
    readonly taskKind?: TaskKind;
    /** The run's directory; a worker's empty `gh` config directory lives in it (ADR-0022). */
    readonly runDir?: string;
    readonly telemetry?: ChildTelemetry;
  },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  // ADR-0022: no worker, of any task kind, holds a GitHub token: the engine checks, pushes and opens
  // the pull request itself (ADR-0018 did the same for `ui_check`). These variables also stop the
  // owner's own `gh` login and global git credential helper (`HOME` is inherited) from being picked
  // up by accident; they remove the accidental routes, not the deliberate ones.
  if (options.role === 'worker') {
    if (options.runDir !== undefined) env['GH_CONFIG_DIR'] = join(options.runDir, WORKER_GH_DIR);
    env['GIT_CONFIG_GLOBAL'] = '/dev/null';
    env['GIT_CONFIG_NOSYSTEM'] = '1';
    env['GIT_TERMINAL_PROMPT'] = '0';
  }
  if (options.telemetry?.enabled) Object.assign(env, telemetryEnv(options.role, options.telemetry));
  return env;
}
