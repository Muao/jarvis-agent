import type { TaskEvent } from '../../domain/index.js';

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
  /** The newest rows across all tasks, newest first. */
  recent(limit: number): Promise<readonly JournalEntry[]>;
}
