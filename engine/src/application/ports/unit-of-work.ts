import type { JournalRepository } from './journal-repository.js';
import type { MessageRepository } from './message-repository.js';
import type { PermissionRepository } from './permission-repository.js';
import type { RunRepository } from './run-repository.js';
import type { SessionRepository } from './session-repository.js';
import type { TaskRepository } from './task-repository.js';
import type { ThreadRepository } from './thread-repository.js';
import type { WatchRepository } from './watch-repository.js';

export interface Repositories {
  readonly threads: ThreadRepository;
  readonly messages: MessageRepository;
  readonly tasks: TaskRepository;
  readonly journal: JournalRepository;
  readonly sessions: SessionRepository;
  readonly runs: RunRepository;
  readonly permissions: PermissionRepository;
  readonly watches: WatchRepository;
}

/**
 * One database transaction. Everything `work` writes commits together or, if it throws, not at all.
 * Every task state change appends its `TaskEvent` through `tx.journal` inside the same `run` (ADR-0008).
 * Notifications to the owner and the run coordinator happen after `run` resolves, never inside `work`.
 */
export interface UnitOfWork {
  run<T>(work: (tx: Repositories) => Promise<T>): Promise<T>;
}
