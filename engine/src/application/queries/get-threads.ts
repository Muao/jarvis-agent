import type { ThreadDto } from '@jarvis/shared';
import type { Task } from '../../domain/index.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { toThreadDto } from './thread-dto.js';
import { currentTaskOf } from './waiting.js';
import { workingTasks } from './working-tasks.js';

/** `GET /api/threads`: threads waiting for the owner first, then the most recently active (SLK list). */
export class GetThreads {
  constructor(private readonly deps: { readonly uow: UnitOfWork }) {}

  execute(): Promise<ThreadDto[]> {
    return this.deps.uow.run(async (tx) => {
      const threads = await tx.threads.list();
      const withCards = new Set(await tx.messages.threadsWithOpenCards());
      const working = await workingTasks(tx);
      const tasksByThread = new Map<string, Task[]>();
      for (const task of await tx.tasks.listAll()) {
        tasksByThread.set(task.threadId, [...(tasksByThread.get(task.threadId) ?? []), task]);
      }
      const rows = threads.map((thread) =>
        toThreadDto(
          thread,
          currentTaskOf(tasksByThread.get(thread.id) ?? []),
          withCards.has(thread.id),
          working,
        ),
      );
      // `threads` is already newest first and the sort is stable, so ties keep that order.
      return rows.sort((a, b) => Number(b.waitingForOwner) - Number(a.waitingForOwner));
    });
  }
}
