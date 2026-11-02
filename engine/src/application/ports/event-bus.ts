import type { StreamEvent } from '@jarvis/shared';

/** Live notifications (thread, task, overview, ...); called after commit. */
export interface EventBus {
  publish(event: StreamEvent): Promise<void>;
}
