import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentRunner,
  RunEventBody,
  RunHandle,
  RunListener,
  RunSpec,
} from '../../application/index.js';
import type { RunOutcome } from '../../domain/index.js';
import type { EnvSource } from '../config/index.js';
import { buildChildEnv, WORKER_GH_DIR } from './child-env.js';
import { buildRunArgs } from './run-args.js';
import type { RunContext } from './run-context.js';
import { writeRunFiles } from './run-files.js';
import { createStreamParser, parseLine } from './stream-json.js';

const STDERR_TAIL_BYTES = 4096;
const DEFAULT_KILL_GRACE_MS = 5000;

export interface ClaudeCliRunnerOptions {
  /** `engine.claudeBinary` from the config. */
  readonly binary: string;
  /** Environment the child env is filtered from; `process.env` is passed in by the composition root. */
  readonly envSource: EnvSource;
  /** Added to the child env after filtering (composition root only). */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** Paths and MCP command of one run. */
  contextFor(spec: RunSpec): RunContext;
  /** Masks secrets in captured stderr (SEC-04). */
  readonly redact?: (text: string) => string;
  readonly killGraceMs?: number;
}

const userLine = (text: string): string =>
  `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The only caller of a model (ADR-0003): one `claude -p` process per run. */
export class ClaudeCliRunner implements AgentRunner {
  constructor(private readonly options: ClaudeCliRunnerOptions) {}

  start(spec: RunSpec, listener: RunListener): RunHandle {
    return new Execution(this.options, spec, listener);
  }
}

class Execution implements RunHandle {
  private child: ChildProcess | undefined;
  private stopRequested = false;
  private stdinOpen = true;
  private readonly pendingInput: string[] = [];
  private outcome: RunOutcome | undefined;
  private stderrTail = '';
  private settled = false;
  private chain: Promise<void> = Promise.resolve();
  private readonly finished: Promise<void>;
  private resolveFinished: () => void = () => {};

  constructor(
    private readonly options: ClaudeCliRunnerOptions,
    private readonly spec: RunSpec,
    private readonly listener: RunListener,
  ) {
    this.finished = new Promise((resolve) => {
      this.resolveFinished = resolve;
    });
    void this.launch();
  }

  send(text: string): void {
    this.writeInput(userLine(text));
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(
        () => child.kill('SIGKILL'),
        this.options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
      );
      void this.finished.then(() => clearTimeout(timer));
    }
    await this.finished;
  }

  private writeInput(line: string): void {
    if (!this.stdinOpen) return;
    const stdin = this.child?.stdin;
    if (!stdin) {
      this.pendingInput.push(line);
      return;
    }
    stdin.write(line);
  }

  private endInput(): void {
    if (!this.stdinOpen) return;
    this.stdinOpen = false;
    this.child?.stdin?.end();
  }

  private async launch(): Promise<void> {
    const { options, spec } = this;
    let child: ChildProcess;
    try {
      const ctx = options.contextFor(spec);
      await mkdir(ctx.runDir, { recursive: true });
      await writeRunFiles(ctx.runDir, spec, ctx);
      // `GH_CONFIG_DIR` of a worker: empty, so `gh` finds no login there (ADR-0022).
      if (spec.role === 'worker') await mkdir(join(ctx.runDir, WORKER_GH_DIR), { recursive: true });
      if (this.stopRequested) return this.finish({ type: 'stopped' });
      const env = {
        ...buildChildEnv(options.envSource, {
          role: spec.role,
          runDir: ctx.runDir,
          ...(spec.taskKind === undefined ? {} : { taskKind: spec.taskKind }),
          telemetry: {
            ...ctx.config.telemetry,
            runId: spec.runId,
            sessionId: spec.sessionId,
            ...(spec.taskId === undefined ? {} : { taskId: spec.taskId }),
          },
        }),
        ...options.extraEnv,
      };
      child = spawn(options.binary, buildRunArgs(spec, ctx), {
        cwd: spec.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      return this.fail(`Cannot start claude: ${reason(error)}`);
    }
    this.child = child;

    child.on('error', (error: NodeJS.ErrnoException) => {
      const hint =
        error.code === 'ENOENT' ? ` (is "${options.binary}" installed and on PATH?)` : '';
      void this.fail(`Cannot start "${options.binary}": ${error.message}${hint}`);
    });
    child.stdin?.on('error', () => {
      this.stdinOpen = false; // the process is gone; its exit is reported by 'close'
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.collectStderr(chunk));

    const parser = createStreamParser();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => parser.push(chunk).forEach((l) => this.handle(l)));
    child.on('close', (code, signal) => {
      parser.flush().forEach((l) => this.handle(l));
      void this.chain.then(() => this.onClose(code, signal));
    });

    this.writeInput(userLine(spec.firstMessage));
    for (const line of this.pendingInput.splice(0)) child.stdin?.write(line);
    if (this.stopRequested) await this.stop();
  }

  private collectStderr(chunk: string): void {
    const redact = this.options.redact ?? ((text: string) => text);
    this.stderrTail = (this.stderrTail + redact(chunk)).slice(-STDERR_TAIL_BYTES);
  }

  private handle(line: string): void {
    for (const parsed of parseLine(line)) {
      switch (parsed.type) {
        case 'event':
          this.enqueue(() => this.listener.event(parsed.body));
          break;
        case 'session':
          this.enqueue(() => this.listener.session(parsed.sessionId));
          break;
        case 'outcome':
          this.outcome = parsed.outcome;
          this.endInput(); // the run is over: let the process end
          break;
      }
    }
  }

  /** Listener calls run strictly in order and never throw into the stream. */
  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(async () => {
      try {
        await task();
      } catch {
        // The application logs listener failures; the stream carries on.
      }
    });
  }

  private onClose(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.stopRequested) return this.finish({ type: 'stopped' });
    if (this.outcome) return this.finish(this.outcome);
    const tail = this.stderrTail.trim();
    const how = signal ? `was killed by ${signal}` : `exited with code ${code ?? 'unknown'}`;
    const message = `claude ${how} without a result${tail ? `: ${tail}` : ''}`;
    return this.finish({ type: 'exit', code, message }, message);
  }

  private fail(message: string): Promise<void> {
    return this.finish({ type: 'exit', code: null, message }, message);
  }

  private async finish(outcome: RunOutcome, errorEvent?: string): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    if (errorEvent !== undefined) {
      const body: RunEventBody = { kind: 'error', payload: { message: errorEvent } };
      this.enqueue(() => this.listener.event(body));
    }
    this.enqueue(() => this.listener.exit(outcome));
    await this.chain;
    this.resolveFinished();
  }
}
