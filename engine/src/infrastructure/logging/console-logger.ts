import type { LogContext, Logger } from '../../application/ports/logger.js';

type Level = 'warn' | 'error';
type Write = (line: string) => void;

export interface ConsoleLoggerOptions {
  /** Masks secrets in every line (SEC-04, ADR-0007). */
  readonly redact: (text: string) => string;
  /** Where lines go; stderr by default. */
  readonly write?: Write;
  readonly now?: () => Date;
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

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }

  private log(level: Level, message: string, context: LogContext = {}): void {
    let line: string;
    try {
      line = JSON.stringify({ time: this.now().toISOString(), level, message, ...context });
    } catch {
      line = JSON.stringify({ time: this.now().toISOString(), level, message });
    }
    this.write(this.options.redact(line));
  }
}
