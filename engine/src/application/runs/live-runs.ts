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
  private readonly endListeners = new Map<string, Set<() => void>>();

  add(run: LiveRun): void {
    this.runs.set(run.runId, run);
  }

  remove(runId: string): void {
    this.runs.delete(runId);
    const listeners = this.endListeners.get(runId);
    this.endListeners.delete(runId);
    for (const listener of listeners ?? []) listener();
  }

  /**
   * ADR-0022: calls `listener` once when the run ends (a tool call that outlives its worker, like
   * the check gate of `open_pr`, stops with it). Returns a function that drops the listener.
   */
  onEnd(runId: string, listener: () => void): () => void {
    const set = this.endListeners.get(runId) ?? new Set<() => void>();
    set.add(listener);
    this.endListeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.endListeners.delete(runId);
    };
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

  /** The tasks whose worker holds a slot now. */
  workerTaskIds(): string[] {
    return [...this.runs.values()].flatMap((r) =>
      r.role === 'worker' && r.taskId !== null ? [r.taskId] : [],
    );
  }

  /** Worker slots in use. */
  workerCount(): number {
    return [...this.runs.values()].filter((r) => r.role === 'worker').length;
  }
}
