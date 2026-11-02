import type { WaitingFor } from '@jarvis/shared';
import { isActive, waitingFor, type Task } from '../../domain/index.js';
import type { RunCoordinator } from '../ports/run-coordinator.js';
import type { Repositories } from '../ports/unit-of-work.js';
import type { Watch } from '../ports/watch-repository.js';

/** `waitingFor` of a task, from the facts the domain rule needs. Reads only. */
export class TaskWaiting {
  constructor(private readonly runs: Pick<RunCoordinator, 'isQueued'>) {}

  async of(tx: Repositories, task: Task, watch: Watch | null): Promise<WaitingFor> {
    return waitingFor(task, {
      queued: await this.runs.isQueued(task.id),
      pendingOwnerCard: (await tx.messages.openCards(task.id)).length > 0,
      ciGreen: watch?.summary?.ciGreen ?? false,
    });
  }
}

/** The task a thread shows: its active one, else the newest. `tasks` is oldest first. */
export function currentTaskOf(tasks: readonly Task[]): Task | null {
  return tasks.find(isActive) ?? tasks.at(-1) ?? null;
}

/**
 * The thread waits for the owner (the "waiting for you" mark and counter): a card is unanswered, or its
 * active task is in a stage that only the owner can move on (Spec Review, Blocked).
 */
export function threadNeedsOwner(task: Task | null, hasOpenCard: boolean): boolean {
  if (hasOpenCard) return true;
  return (
    task !== null &&
    isActive(task) &&
    waitingFor(task, { queued: false, pendingOwnerCard: false }) === 'owner'
  );
}
