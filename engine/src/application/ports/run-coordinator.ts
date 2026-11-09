import type { IsoTime } from '../../domain/index.js';

export type WorkerRunReason = 'start' | 'resume' | 'retry';

/** Work that waits for a worker slot (Overview, Queue). */
export interface QueuedWorkerRun {
  readonly taskId: string;
  readonly reason: WorkerRunReason;
  readonly since: IsoTime;
}

/**
 * The seam to the run scheduler (implemented by T05 in `application/runs`). Task and conversation
 * use cases only call it, and only after their transaction committed. Every method is idempotent:
 * asking twice for the same work must not start two processes.
 */
export interface RunCoordinator {
  /** Process the thread's queued owner messages in one dispatcher turn, one turn at a time per thread. */
  requestDispatcherTurn(threadId: string): Promise<void>;
  /** Queue (or start) a worker run for the task. */
  requestWorkerRun(taskId: string, reason: WorkerRunReason): Promise<void>;
  /** Hand queued owner input to the task's live worker; with no live worker, start the next run. */
  deliverToWorker(taskId: string): Promise<void>;
  /** Stop the task's running process and drop its queued work (cancel, failure). */
  stopTaskRuns(taskId: string): Promise<void>;
  /** The task waits for a worker slot (feeds `waitingFor`). */
  isQueued(taskId: string): Promise<boolean>;
  /** The waiting worker work in the order it will start. */
  queueSnapshot(): Promise<readonly QueuedWorkerRun[]>;
}
