import type { LogContext, Logger } from '../../application/ports/logger.js';

export type LogLevel = 'error' | 'warn' | 'info';

/** A line is written when its level is at least as severe as the configured one. */
const SEVERITY: Readonly<Record<LogLevel, number>> = { error: 0, warn: 1, info: 2 };
type Write = (line: string) => void;

export interface ConsoleLoggerOptions {
  /** Masks secrets in every line (SEC-04, ADR-0015). */
  readonly redact: (text: string) => string;
  /** Where lines go; stderr by default. */
  readonly write?: Write;
  readonly now?: () => Date;
  /** Lines less severe than this are dropped; `info` by default. */
  readonly level?: LogLevel;
}

const toStderr: Write = (line) => {
  process.stderr.write(`${line}\n`);
};

/** One JSON line per entry on stderr, redacted after serialisation so no field can leak a secret. */
export class ConsoleLogger implements Logger {
  private readonly write: Write;
  private readonly now: () => Date;

  constructor(private readonly options: ConsoleLoggerOptions) {
    this.write = options.write ?? toStderr;
    this.now = options.now ?? (() => new Date());
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }

  private log(level: LogLevel, message: string, context: LogContext = {}): void {
    if (SEVERITY[level] > SEVERITY[this.options.level ?? 'info']) return;
    let line: string;
    try {
      line = JSON.stringify({ time: this.now().toISOString(), level, message, ...context });
    } catch {
      line = JSON.stringify({ time: this.now().toISOString(), level, message });
    }
    this.write(this.options.redact(line));
  }
}
