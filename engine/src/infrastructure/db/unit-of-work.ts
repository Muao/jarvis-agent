import { AsyncLocalStorage } from 'node:async_hooks';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Repositories, UnitOfWork } from '../../application/ports/unit-of-work.js';
import type { Executor } from './client.js';
import { PgBudgetResetRepository } from './budget-reset-repository.js';
import { PgJournalRepository } from './journal-repository.js';
import { PgMessageRepository } from './message-repository.js';
import { PgPermissionRepository } from './permission-repository.js';
import { PgRunRepository } from './run-repository.js';
import { PgSessionRepository } from './session-repository.js';
import { PgTaskRepository } from './task-repository.js';
import { PgThreadRepository } from './thread-repository.js';
import { PgWatchRepository } from './watch-repository.js';

/** Repositories bound to one executor: the pool (each call is its own statement) or a transaction. */
export function createRepositories(db: Executor): Repositories {
  return {
    threads: new PgThreadRepository(db),
    messages: new PgMessageRepository(db),
    tasks: new PgTaskRepository(db),
    journal: new PgJournalRepository(db),
    sessions: new PgSessionRepository(db),
    runs: new PgRunRepository(db),
    permissions: new PgPermissionRepository(db),
    watches: new PgWatchRepository(db),
    budgetResets: new PgBudgetResetRepository(db),
  };
}

/**
 * One `run` = one Postgres transaction on one pooled connection (ADR-0008): everything `work` writes
 * commits together, or, if it throws, not at all.
 *
 * Nesting: calling `run` from inside `work` (on the same unit of work) throws. A second `run` would
 * need a second connection and a second, independent transaction, so it could not roll back with the
 * outer one and could deadlock against it. Use the `tx` repositories you were given instead.
 */
export class PgUnitOfWork implements UnitOfWork {
  private readonly active = new AsyncLocalStorage<true>();

  constructor(private readonly db: NodePgDatabase) {}

  run<T>(work: (tx: Repositories) => Promise<T>): Promise<T> {
    if (this.active.getStore() === true) {
      return Promise.reject(
        new Error('UnitOfWork.run was called inside another run; use the tx you were given'),
      );
    }
    return this.db.transaction((tx) => this.active.run(true, () => work(createRepositories(tx))));
  }
}
