import type { IsoTime } from './time.js';
import { isActive, type Task } from './task.js';

export interface Thread {
  readonly id: string;
  readonly title: string;
  readonly createdAt: IsoTime;
  readonly updatedAt: IsoTime;
}

export function createThread(input: { id: string; title: string; at: IsoTime }): Thread {
  return { id: input.id, title: input.title, createdAt: input.at, updatedAt: input.at };
}

export function touchThread(thread: Thread, at: IsoTime): Thread {
  return { ...thread, updatedAt: at };
}

/** Where an owner message goes (plan "Routing rules", DSP-04). */
export type OwnerMessageRoute = 'worker_input' | 'dispatcher' | 'dispatcher_queued';

export function routeOwnerMessage(input: {
  /** The thread's task, if any; a terminal task counts as none. */
  readonly task: Pick<Task, 'stage'> | null;
  /** A dispatcher turn is running in this thread. */
  readonly dispatcherBusy: boolean;
}): OwnerMessageRoute {
  if (input.task !== null && isActive(input.task)) return 'worker_input';
  return input.dispatcherBusy ? 'dispatcher_queued' : 'dispatcher';
}
