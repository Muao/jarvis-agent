import type { Role, RunEvent } from '@jarvis/shared';
import type { RunOutcome } from '../../domain/index.js';

/** A normalised stream-json line before the engine stamps it with `seq`, `runId` and `at`. */
export type RunEventBody = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, 'seq' | 'runId' | 'at'>
    : never
  : never;

/**
 * Everything one `claude` process needs to be started. The adapter (infrastructure) turns it into
 * argv, environment and run files; the application knows no flags (ADR-0004, ADR-0011).
 */
export interface RunSpec {
  readonly runId: string;
  readonly role: Role;
  /** The worktree for a worker, the repository for the dispatcher. */
  readonly cwd: string;
  readonly firstMessage: string;
  /** The CLI's own session id from an earlier run of the same session. */
  readonly resumeSessionId?: string;
  readonly model: string;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  /** Proves the run's identity to the MCP server (ADR-0005). */
  readonly runToken: string;
  /** Workers take owner input while they run, so their stdin stays open. */
  readonly keepStdinOpen: boolean;
  readonly taskId?: string;
  /** ADR-0022: where Playwright MCP writes the UI check's screenshots; workers only. */
  readonly screenshotsDir?: string;
  readonly threadId: string;
  /** Jarvis's session row (not the CLI's id); labels the run's telemetry (ADR-0018). */
  readonly sessionId: string;
}

/**
 * What the adapter reports. Calls for one run arrive in order; the adapter should await each one.
 * Implementations never reject: failures are logged by the application.
 */
export interface RunListener {
  event(body: RunEventBody): Promise<void>;
  /** The CLI told us its session id (stored for `--resume`). */
  session(claudeSessionId: string): Promise<void>;
  /** The process ended. Called exactly once, after the last event. */
  exit(outcome: RunOutcome): Promise<void>;
}

export interface RunHandle {
  /** Write an owner message to the live process. */
  send(text: string): void;
  /** Ask the process to end; the listener then receives `exit({ type: 'stopped' })`. */
  stop(): Promise<void>;
}

export interface AgentRunner {
  start(spec: RunSpec, listener: RunListener): RunHandle;
}
