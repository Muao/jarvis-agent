import type { TaskDto } from '@jarvis/shared';
import type { RunCoordinator } from '../ports/run-coordinator.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { toTaskDto } from './task-dto.js';
import { TaskWaiting } from './waiting.js';

/** `GET /api/tasks`: every task, most recently updated first. */
export class GetTasks {
  private readonly waiting: TaskWaiting;

  constructor(private readonly deps: { readonly uow: UnitOfWork; readonly runs: RunCoordinator }) {
    this.waiting = new TaskWaiting(deps.runs);
  }

  execute(): Promise<TaskDto[]> {
    return this.deps.uow.run(async (tx) => {
      const totals = await tx.runs.totalsByTask();
      const tasks = [...(await tx.tasks.listAll())].sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
      );
      const rows: TaskDto[] = [];
      for (const task of tasks) {
        const watch = task.pr === null ? null : await tx.watches.get(task.id);
        rows.push(
          toTaskDto(task, {
            waitingFor: await this.waiting.of(tx, task, watch),
            watch,
            totals: totals.get(task.id),
          }),
        );
      }
      return rows;
    });
  }
}
