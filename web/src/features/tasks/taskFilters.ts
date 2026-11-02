import type { TaskDto } from '@jarvis/shared';

export const TASK_FILTERS = ['All', 'Active', 'Waiting', 'Done', 'Failed', 'Cancelled'] as const;
export type TaskFilter = (typeof TASK_FILTERS)[number];

const isTerminal = (task: TaskDto) =>
  task.stage === 'Done' || task.stage === 'Failed' || task.stage === 'Cancelled';

/** Active = running without anybody to wait for; Waiting = open but waiting for owner, CI, review or a slot. */
const MATCHES: Record<TaskFilter, (task: TaskDto) => boolean> = {
  All: () => true,
  Active: (task) => !isTerminal(task) && task.waitingFor === '—',
  Waiting: (task) => !isTerminal(task) && task.waitingFor !== '—',
  Done: (task) => task.stage === 'Done',
  Failed: (task) => task.stage === 'Failed',
  Cancelled: (task) => task.stage === 'Cancelled',
};

export function filterTasks(tasks: TaskDto[], filter: TaskFilter, search: string): TaskDto[] {
  const needle = search.trim().toLowerCase();
  return tasks.filter(
    (task) =>
      MATCHES[filter](task) &&
      (needle === '' ||
        task.title.toLowerCase().includes(needle) ||
        task.id.toLowerCase().includes(needle)),
  );
}
