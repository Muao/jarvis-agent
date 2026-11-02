import type { TaskStage, WaitingFor } from '@jarvis/shared';
import { waitingFor, type Task } from '../../domain/index.js';
import type { RunCoordinator } from '../ports/run-coordinator.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { RunIdentity } from '../run-identity.js';
import { requireDispatcher } from '../tasks/guards.js';

export interface TaskSummary {
  readonly id: string;
  readonly title: string;
  readonly stage: TaskStage;
  readonly waitingFor: WaitingFor;
  readonly prUrl: string | null;
}

export interface TaskList {
  readonly tasks: readonly TaskSummary[];
  /** Ready-to-send status text for the owner (DSP-05). */
  readonly text: string;
}

function lineOf(task: TaskSummary): string {
  const waiting = task.waitingFor === '—' ? '' : `, waiting for ${task.waitingFor}`;
  const pr = task.prUrl === null ? '' : ` — ${task.prUrl}`;
  return `${task.id} ${task.title}: ${task.stage}${waiting}${pr}`;
}

/** DSP-05: the active tasks with their stage, what they wait for and the PR link. Reads only. */
export class ListTasks {
  constructor(private readonly deps: { readonly uow: UnitOfWork; readonly runs: RunCoordinator }) {}

  async execute(identity: RunIdentity): Promise<TaskList> {
    requireDispatcher(identity);
    return this.deps.uow
      .run(async (tx) => {
        const active = await tx.tasks.listActive();
        return Promise.all(
          active.map(async (task: Task): Promise<TaskSummary> => {
            const cards = await tx.messages.openCards(task.id);
            const watch = await tx.watches.get(task.id);
            return {
              id: task.id,
              title: task.title,
              stage: task.stage,
              waitingFor: waitingFor(task, {
                queued: await this.deps.runs.isQueued(task.id),
                pendingOwnerCard: cards.length > 0,
                ciGreen: watch?.summary?.ciGreen ?? false,
              }),
              prUrl: task.pr?.url ?? null,
            };
          }),
        );
      })
      .then((tasks) => ({
        tasks,
        text: tasks.length === 0 ? 'No active tasks.' : tasks.map(lineOf).join('\n'),
      }));
  }
}
