export type LogContext = Readonly<Record<string, unknown>>;

/**
 * Diagnostics and lifecycle lines (never secrets: the adapter redacts, ADR-0015). Lifecycle lines at
 * `info` carry an `event` key and the ids as context; the names are a contract with the log pipeline
 * (ADR-0016): event, runId, sessionId, taskId, threadId, role, model, costUsd, turns, stopReason, durationMs.
 */
export interface Logger {
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}
