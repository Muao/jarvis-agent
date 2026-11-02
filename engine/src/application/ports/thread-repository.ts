import type { Thread } from '../../domain/index.js';

export interface ThreadRepository {
  get(id: string): Promise<Thread | null>;
  /** Insert or update. */
  save(thread: Thread): Promise<void>;
  /** Every thread, most recently active first. */
  list(): Promise<readonly Thread[]>;
}
