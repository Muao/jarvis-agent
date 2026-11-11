import type { IsoTime, TaskEvent } from '../../domain/index.js';

/** A stored journal row; `seq` grows with every append across all tasks. */
export interface JournalEntry extends TaskEvent {
  readonly seq: number;
}

/** The append-only task journal (ST-03, ADR-0008). There is no update and no delete. */
export interface JournalRepository {
  append(event: TaskEvent): Promise<void>;
  /** Events of one task, oldest first. */
  list(taskId: string): Promise<readonly TaskEvent[]>;
  /** Rows of one task, oldest first. */
  entries(taskId: string): Promise<readonly JournalEntry[]>;
  /** Events of the given types written at or after `since`, across all tasks, oldest first. */
  ofTypesSince(types: readonly string[], since: IsoTime): Promise<readonly TaskEvent[]>;
  /** The newest rows across all tasks, newest first. */
  recent(limit: number): Promise<readonly JournalEntry[]>;
}
