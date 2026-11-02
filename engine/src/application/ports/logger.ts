export type LogContext = Readonly<Record<string, unknown>>;

/** Diagnostics for failures the caller cannot act on (never secrets: the adapter redacts, ADR-0007). */
export interface Logger {
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}
