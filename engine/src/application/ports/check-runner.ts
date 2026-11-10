/** ADR-0022: what one check command did. `exitCode` is null when it was killed or never started. */
export interface CheckResult {
  readonly command: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** The last 60 lines of its output, at most 4 000 characters. */
  readonly tail: string;
}

export interface CheckRunSpec {
  /** The task's worktree. */
  readonly cwd: string;
  /** The frozen command list, run in order (ADR-0022). */
  readonly commands: readonly string[];
  /** Per command. */
  readonly timeoutMs: number;
  /** Aborting kills the running command's whole process group and stops the loop. */
  readonly signal: AbortSignal;
  /** Called about every 30 seconds while a command runs, e.g. `checks running: pnpm test (30s)`. */
  readonly onProgress: (line: string) => void;
  /** Absolute path of the full log; the runner appends to it. */
  readonly logPath: string;
}

export interface CheckRunOutcome {
  readonly results: readonly CheckResult[];
  /** Set when a command could not be started (spawn error, exit 127); the loop stopped there. */
  readonly unavailable: { readonly command: string; readonly detail: string } | null;
}

/**
 * ADR-0022: runs the owner-approved check commands in a worktree. Never throws for a red command;
 * red is a result.
 */
export interface CheckRunner {
  run(spec: CheckRunSpec): Promise<CheckRunOutcome>;
}
