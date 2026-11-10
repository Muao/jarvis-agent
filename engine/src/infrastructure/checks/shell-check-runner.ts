import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  CheckResult,
  CheckRunOutcome,
  CheckRunner,
  CheckRunSpec,
} from '../../application/ports/check-runner.js';
import { buildCheckEnv, type EnvSource } from './build-check-env.js';

type Spawn = typeof nodeSpawn;

const DEFAULT_KILL_GRACE_MS = 5000;
const DEFAULT_PROGRESS_MS = 30_000;
/** How long the pipes may stay open after the shell exited before they are cut. */
const DRAIN_MS = 1000;
/** ADR-0022: at most this much of a gate's output goes to the log file live. */
const LOG_CAP_BYTES = 5 * 1024 * 1024;
/** What is kept in memory once the cap is hit, per command: the end of the output. */
const OVERFLOW_TAIL_BYTES = 512 * 1024;
/** What the result's `tail` is cut from. */
const TAIL_SOURCE_CHARS = 64 * 1024;
const TAIL_LINES = 60;
const TAIL_CHARS = 4000;

export interface ShellCheckRunnerOptions {
  /** Where the allow-listed environment is taken from (the engine's, read in the composition root). */
  readonly env: EnvSource;
  readonly spawn?: Spawn;
  /** Injectable so a unit test never signals a real process group. */
  readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly killGraceMs?: number;
  readonly progressMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The last 60 lines of `text`, and at most 4 000 characters of those. */
export function tailOf(text: string): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  const joined = lines.slice(-TAIL_LINES).join('\n');
  return joined.length > TAIL_CHARS ? joined.slice(-TAIL_CHARS) : joined;
}

/**
 * ADR-0022. Runs each command with `sh -c` in the worktree, one detached process group per
 * command (the lesson of `ProcessDevServer`: a shell forks, and killing the shell alone leaves
 * the test runner behind), with the dev server's kind of environment — a short allow-list, no
 * engine secret. All commands run even after a red one; a command that cannot be started stops
 * the loop and is reported as `unavailable`, which is not the code's fault.
 */
export class ShellCheckRunner implements CheckRunner {
  private readonly spawn: Spawn;
  private readonly killProcess: (pid: number, signal: NodeJS.Signals) => void;

  constructor(private readonly options: ShellCheckRunnerOptions) {
    this.spawn = options.spawn ?? nodeSpawn;
    this.killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  }

  async run(spec: CheckRunSpec): Promise<CheckRunOutcome> {
    await mkdir(dirname(spec.logPath), { recursive: true });
    const log = new LogSink(spec.logPath);
    const results: CheckResult[] = [];
    let unavailable: CheckRunOutcome['unavailable'] = null;

    for (const command of spec.commands) {
      if (spec.signal.aborted) break;
      const outcome = await this.runOne(command, spec, log);
      results.push(outcome.result);
      if (outcome.unavailable !== null) {
        unavailable = { command, detail: outcome.unavailable };
        break;
      }
      if (outcome.aborted) break;
    }
    await log.flush();
    return { results, unavailable };
  }

  private async runOne(
    command: string,
    spec: CheckRunSpec,
    log: LogSink,
  ): Promise<{ result: CheckResult; unavailable: string | null; aborted: boolean }> {
    const started = Date.now();
    const output = new OutputBuffer(log);
    await log.header(command);

    let child: ChildProcess;
    try {
      child = this.spawn('sh', ['-c', command], {
        cwd: spec.cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildCheckEnv(this.options.env),
      });
    } catch (error) {
      return this.unstarted(command, started, error, output);
    }

    const pid = child.pid;
    let timedOut = false;
    let aborted = false;
    let spawnError: Error | null = null;
    let stopping: Promise<void> | null = null;

    const stop = (): Promise<void> => {
      stopping ??= pid === undefined ? Promise.resolve() : this.killGroup(pid, child);
      return stopping;
    };

    child.stdout?.on('data', (chunk: Buffer | string) => output.add(chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => output.add(chunk));

    const timeout = setTimeout(() => {
      timedOut = true;
      void stop();
    }, spec.timeoutMs);
    const progress = setInterval(() => {
      spec.onProgress(`checks running: ${command} (${Math.round((Date.now() - started) / 1000)}s)`);
    }, this.options.progressMs ?? DEFAULT_PROGRESS_MS);
    const onAbort = (): void => {
      aborted = true;
      void stop();
    };
    spec.signal.addEventListener('abort', onAbort, { once: true });
    if (spec.signal.aborted) onAbort();

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        let done = false;
        const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
          if (done) return;
          done = true;
          resolve({ code, signal });
        };
        child.once('error', (error) => {
          spawnError = error;
          finish(null, null);
        });
        child.once('exit', (code, signal) => {
          // The shell is gone; a grandchild may still hold the pipes. Wait briefly, then cut them.
          const cut = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish(code, signal);
          }, DRAIN_MS);
          child.once('close', () => {
            clearTimeout(cut);
            finish(code, signal);
          });
        });
      },
    );

    clearTimeout(timeout);
    clearInterval(progress);
    spec.signal.removeEventListener('abort', onAbort);
    // Whatever the command left running in its group (a background server) goes with it.
    if (pid !== undefined) this.signalGroup(pid, 'SIGKILL');
    await stopping;
    await output.finish(timedOut, aborted);

    const err = spawnError as Error | null;
    const result: CheckResult = {
      command,
      exitCode: err !== null ? null : exit.code,
      timedOut,
      durationMs: Date.now() - started,
      tail: tailOf(err !== null ? `${output.tail()}\n${err.message}` : output.tail()),
    };
    if (err !== null) return { result, unavailable: `Could not start: ${err.message}`, aborted };
    if (exit.code === 127 && !timedOut && !aborted) {
      return {
        result,
        unavailable:
          `The shell reported the command as not found (exit 127). ${result.tail}`.trim(),
        aborted,
      };
    }
    return { result, unavailable: null, aborted };
  }

  private unstarted(
    command: string,
    started: number,
    error: unknown,
    output: OutputBuffer,
  ): { result: CheckResult; unavailable: string; aborted: boolean } {
    const message = error instanceof Error ? error.message : String(error);
    output.add(`${message}\n`);
    return {
      result: {
        command,
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - started,
        tail: tailOf(message),
      },
      unavailable: `Could not start: ${message}`,
      aborted: false,
    };
  }

  /** SIGTERM to the group, SIGKILL after the grace period if the shell is still there. */
  private async killGroup(pid: number, child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      this.signalGroup(pid, 'SIGKILL');
      return;
    }
    this.signalGroup(pid, 'SIGTERM');
    const grace = this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const deadline = Date.now() + grace;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      await sleep(Math.min(50, grace));
    }
    // Always: the shell may have exited on SIGTERM while a grandchild ignored it.
    this.signalGroup(pid, 'SIGKILL');
  }

  /** The whole group, falling back to the single pid when there is no group. */
  private signalGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      this.killProcess(-pid, signal);
    } catch {
      try {
        this.killProcess(pid, signal);
      } catch {
        // already gone
      }
    }
  }
}

/** Appends to the gate's log file in order; live up to the cap, the end of the rest at the finish. */
class LogSink {
  private written = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  /** Bytes still allowed live. */
  remaining(): number {
    return Math.max(0, LOG_CAP_BYTES - this.written);
  }

  header(command: string): Promise<void> {
    return this.append(`$ ${command}\n`, true);
  }

  append(text: string, force = false): Promise<void> {
    const bytes = Buffer.byteLength(text);
    if (!force && bytes > this.remaining()) return this.chain;
    this.written += bytes;
    this.chain = this.chain.then(() => appendFile(this.path, text)).catch(() => undefined);
    return this.chain;
  }

  flush(): Promise<void> {
    return this.chain;
  }
}

/**
 * Output of one command: written to the log live while the cap allows, and always kept as a rolling
 * tail for the result. Past the cap only the end survives, with a marker saying so.
 */
class OutputBuffer {
  private recent = '';
  private overflow = '';
  private overflowed = 0;

  constructor(private readonly log: LogSink) {}

  add(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.recent = (this.recent + text).slice(-TAIL_SOURCE_CHARS);
    const room = this.log.remaining();
    const bytes = Buffer.byteLength(text);
    if (this.overflowed === 0 && bytes <= room) {
      void this.log.append(text);
      return;
    }
    this.overflowed += bytes;
    this.overflow = (this.overflow + text).slice(-OVERFLOW_TAIL_BYTES);
  }

  tail(): string {
    return this.recent;
  }

  async finish(timedOut: boolean, aborted: boolean): Promise<void> {
    const notes: string[] = [];
    if (this.overflowed > 0) {
      notes.push(`[output over the ${LOG_CAP_BYTES / 1024 / 1024} MB cap; the end follows]\n`);
      notes.push(this.overflow);
    }
    if (timedOut) notes.push('\n[killed: timed out]\n');
    else if (aborted) notes.push('\n[killed: the run was cancelled]\n');
    await this.log.append(`${notes.join('')}${this.recent.endsWith('\n') ? '' : '\n'}`, true);
  }
}
