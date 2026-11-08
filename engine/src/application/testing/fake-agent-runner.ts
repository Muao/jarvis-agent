import type { RunOutcome } from '../../domain/index.js';
import type {
  AgentRunner,
  RunEventBody,
  RunHandle,
  RunListener,
  RunSpec,
} from '../ports/agent-runner.js';

/** One process the application asked for. Tests drive it: emit events, report a session, exit. */
export class FakeProcess implements RunHandle {
  /** Texts the application wrote to the process. */
  readonly sent: string[] = [];
  stopped = false;
  exited = false;

  constructor(
    readonly spec: RunSpec,
    private readonly listener: RunListener,
  ) {}

  send(text: string): void {
    this.sent.push(text);
  }

  /** Like the real adapter: stopping ends the process with a `stopped` outcome. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.exit({ type: 'stopped' });
  }

  emit(body: RunEventBody): Promise<void> {
    return this.listener.event(body);
  }

  reportSession(claudeSessionId: string): Promise<void> {
    return this.listener.session(claudeSessionId);
  }

  async exit(outcome: RunOutcome): Promise<void> {
    if (this.exited) return;
    this.exited = true;
    await this.listener.exit(outcome);
  }

  /** The CLI's final `result` line for a successful run. */
  succeed(costUsd = 0.1): Promise<void> {
    return this.exit({
      type: 'result',
      subtype: 'success',
      costUsd,
      turns: 3,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
  }
}

/** Records the specs it is given instead of spawning anything (ADR-0011: no test runs `claude`). */
export class FakeAgentRunner implements AgentRunner {
  readonly processes: FakeProcess[] = [];
  private failure: Error | null = null;

  /** The next `start` throws `error`. */
  failNext(error: Error): void {
    this.failure = error;
  }

  start(spec: RunSpec, listener: RunListener): RunHandle {
    if (this.failure !== null) {
      const error = this.failure;
      this.failure = null;
      throw error;
    }
    const process = new FakeProcess(spec, listener);
    this.processes.push(process);
    return process;
  }

  /** Processes that have not exited yet. */
  get live(): FakeProcess[] {
    return this.processes.filter((p) => !p.exited);
  }

  /** The process started for a task / thread's run, newest first. */
  forTask(taskId: string): FakeProcess | undefined {
    return [...this.processes].reverse().find((p) => p.spec.taskId === taskId);
  }

  forThread(threadId: string, role: 'dispatcher' | 'worker'): FakeProcess | undefined {
    return [...this.processes]
      .reverse()
      .find((p) => p.spec.threadId === threadId && p.spec.role === role);
  }
}
