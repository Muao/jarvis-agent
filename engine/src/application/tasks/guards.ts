import { isTerminal, type Message, type Task } from '../../domain/index.js';
import { ForbiddenError, NotFoundError } from '../errors.js';
import type { Repositories } from '../ports/unit-of-work.js';
import type { RunIdentity } from '../run-identity.js';

/** Dispatcher tools are for dispatcher runs only (ADR-0005). */
export function requireDispatcher(identity: RunIdentity): void {
  if (identity.role !== 'dispatcher') {
    throw new ForbiddenError('this tool is only available to the dispatcher');
  }
}

/** A task that exists, by id. */
export async function loadTask(tx: Repositories, taskId: string): Promise<Task> {
  const task = await tx.tasks.get(taskId);
  if (task === null) throw new NotFoundError('task', taskId);
  return task;
}

/**
 * Worker tools act on the worker's own task and only while it is not finished: a run left over
 * from a cancelled or failed task must not change anything.
 */
export async function loadWorkerTask(tx: Repositories, identity: RunIdentity): Promise<Task> {
  if (identity.role !== 'worker' || identity.taskId === undefined) {
    throw new ForbiddenError('this tool is only available to a worker run of a task');
  }
  const task = await loadTask(tx, identity.taskId);
  if (isTerminal(task.stage)) {
    throw new ForbiddenError(
      `task ${task.id} is ${task.stage}; its worker can no longer change it`,
    );
  }
  return task;
}

/** The oldest unanswered card of `kind` among a task's open cards. */
export function findOpenCard(cards: readonly Message[], kind: Message['kind']): Message | null {
  return cards.find((card) => card.kind === kind) ?? null;
}
