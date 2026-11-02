import type { Role } from '@jarvis/shared';
import type { RunHandle } from '../ports/agent-runner.js';

/** A `claude` process this engine started and has not seen exit. */
export interface LiveRun {
  readonly runId: string;
  readonly role: Role;
  readonly threadId: string;
  readonly taskId: string | null;
  readonly token: string;
  /** Null for the moment between registering the run and the runner returning its handle. */
  handle: RunHandle | null;
}

/** In-memory index of live runs: what holds a worker slot, and whom to write to or stop. */
export class LiveRuns {
  private readonly runs = new Map<string, LiveRun>();

  add(run: LiveRun): void {
    this.runs.set(run.runId, run);
  }

  remove(runId: string): void {
    this.runs.delete(runId);
  }

  get(runId: string): LiveRun | undefined {
    return this.runs.get(runId);
  }

  workerOf(taskId: string): LiveRun | undefined {
    return [...this.runs.values()].find((r) => r.role === 'worker' && r.taskId === taskId);
  }

  dispatcherOf(threadId: string): LiveRun | undefined {
    return [...this.runs.values()].find((r) => r.role === 'dispatcher' && r.threadId === threadId);
  }

  /** Worker slots in use. */
  workerCount(): number {
    return [...this.runs.values()].filter((r) => r.role === 'worker').length;
  }
}
