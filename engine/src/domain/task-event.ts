import type { IsoTime } from './time.js';

export type EventActor = 'system' | 'agent' | 'owner';

/**
 * The single journal entry shape (ST-03, ADR-0010). Every use case that changes a task
 * produces one; the unit of work stores it in the same transaction as the change.
 */
export interface TaskEvent {
  readonly taskId: string;
  /** Free-form discriminator, e.g. `stage_changed`, `ci_completed`, `note`. */
  readonly type: string;
  readonly at: IsoTime;
  readonly actor: EventActor;
  readonly data: Readonly<Record<string, unknown>>;
}

export function taskEvent(
  taskId: string,
  type: string,
  at: IsoTime,
  actor: EventActor,
  data: Readonly<Record<string, unknown>> = {},
): TaskEvent {
  return { taskId, type, at, actor, data };
}
