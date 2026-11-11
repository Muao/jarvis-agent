import type { TaskStage, ThreadDto } from '@jarvis/shared';

export type ThreadFilter = 'all' | 'waiting' | 'active' | 'done' | 'archived';

export const FILTERS: { id: ThreadFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'waiting', label: 'Waiting for me' },
  { id: 'active', label: 'Active' },
  { id: 'done', label: 'Done' },
  { id: 'archived', label: 'Archived' },
];

const TERMINAL: readonly TaskStage[] = ['Done', 'Failed', 'Cancelled'];

export const isTerminalStage = (stage: TaskStage | null): boolean =>
  stage !== null && TERMINAL.includes(stage);

/**
 * `Active` includes threads without a task (a conversation is still going); `Done` is the terminal
 * stages. An archived thread shows under `Archived` and nowhere else.
 */
export function matchesFilter(thread: ThreadDto, filter: ThreadFilter): boolean {
  if (thread.archived !== (filter === 'archived')) return false;
  switch (filter) {
    case 'archived':
    case 'all':
      return true;
    case 'waiting':
      return thread.waitingForOwner;
    case 'active':
      return !isTerminalStage(thread.stage);
    case 'done':
      return isTerminalStage(thread.stage);
  }
}

/** Threads waiting for the owner first, then newest activity first. */
export function sortThreads(threads: readonly ThreadDto[]): ThreadDto[] {
  return [...threads].sort((a, b) => {
    if (a.waitingForOwner !== b.waitingForOwner) return a.waitingForOwner ? -1 : 1;
    return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
  });
}

export function visibleThreads(threads: readonly ThreadDto[], filter: ThreadFilter): ThreadDto[] {
  return sortThreads(threads.filter((thread) => matchesFilter(thread, filter)));
}

/** "14:32" in the viewer's zone. */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
