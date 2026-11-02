import type { ThreadDto } from '@jarvis/shared';
import type { Task, Thread } from '../../domain/index.js';
import { threadNeedsOwner } from './waiting.js';

/** A row of the thread list: the thread plus the task it shows, if any. */
export function toThreadDto(thread: Thread, task: Task | null, hasOpenCard: boolean): ThreadDto {
  return {
    id: thread.id,
    title: thread.title,
    taskId: task?.id ?? null,
    stage: task?.stage ?? null,
    prNumber: task?.pr?.number ?? null,
    prUrl: task?.pr?.url ?? null,
    waitingForOwner: threadNeedsOwner(task, hasOpenCard),
    lastActivityAt: thread.updatedAt,
  };
}
