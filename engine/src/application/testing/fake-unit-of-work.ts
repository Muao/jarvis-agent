import type { Repositories, UnitOfWork } from '../ports/unit-of-work.js';
import type { InMemoryDatabase } from './in-memory-database.js';
import { inMemoryRepositories } from './in-memory-repositories.js';

/**
 * Transactions over the in-memory tables: work runs one at a time, and if it throws every change
 * it made is undone, like a rolled-back Postgres transaction.
 */
export class FakeUnitOfWork implements UnitOfWork {
  private tail: Promise<unknown> = Promise.resolve();
  /** The repositories every transaction hands out; tests may spy on them. */
  readonly repositories: Repositories;

  constructor(private readonly db: InMemoryDatabase) {
    this.repositories = inMemoryRepositories(db);
  }

  run<T>(work: (tx: Repositories) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const before = this.db.snapshot();
      try {
        return await work(this.repositories);
      } catch (error) {
        this.db.restore(before);
        throw error;
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}
