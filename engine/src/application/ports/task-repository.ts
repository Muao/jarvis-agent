import type { Task } from '../../domain/index.js';

export interface TaskRepository {
  get(id: string): Promise<Task | null>;
  /** Insert or update. */
  save(task: Task): Promise<void>;
  /** Next `T-<n>` id. Sequence-backed: an id is never reused, even after a rollback. */
  nextId(): Promise<string>;
  /** The non-terminal task of a thread, if any (a thread has at most one). */
  activeForThread(threadId: string): Promise<Task | null>;
  /** All non-terminal tasks, oldest first. */
  listActive(): Promise<readonly Task[]>;
  /** Every task, finished ones included, oldest first. */
  listAll(): Promise<readonly Task[]>;
  /** The tasks of one thread, oldest first. */
  listByThread(threadId: string): Promise<readonly Task[]>;
}
