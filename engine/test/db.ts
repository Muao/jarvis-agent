// Integration-test harness (ADR-0013): real Postgres on the `jarvis_test` database.
// Migrates once per test file and empties every table between tests. Refuses any database not named `*_test`.
import { afterAll, afterEach, beforeAll } from 'vitest';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import type { Repositories } from '../src/application/ports/unit-of-work.js';
import {
  createDatabase,
  createPool,
  createRepositories,
  migrate,
  PgUnitOfWork,
} from '../src/infrastructure/db/index.js';

export const DEFAULT_TEST_DATABASE_URL = 'postgres://jarvis:jarvis@127.0.0.1:5433/jarvis_test';

const TABLES = [
  'run_events',
  'permission_requests',
  'watches',
  'runs',
  'sessions',
  'messages',
  'task_events',
  'tasks',
  'threads',
] as const;

/** Throws unless the URL points at a database whose name ends in `_test`. */
export function assertTestDatabase(url: string): void {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run integration tests against database "${name}": name must end in _test`,
    );
  }
}

export function testDatabaseUrl(): string {
  const url = process.env['DATABASE_URL_TEST'] ?? DEFAULT_TEST_DATABASE_URL;
  assertTestDatabase(url);
  return url;
}

export interface TestDatabase {
  readonly pool: pg.Pool;
  readonly db: NodePgDatabase;
  /** Repositories on the pool (each call is its own statement, outside any transaction). */
  readonly repos: Repositories;
  readonly uow: PgUnitOfWork;
}

export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query(`truncate ${TABLES.join(', ')} restart identity cascade`);
  await pool.query('alter sequence task_ids restart with 1');
}

/**
 * Call at the top of a `describe` or file: migrates in `beforeAll`, truncates after each test and closes
 * the pool in `afterAll`. Use the returned object inside tests.
 */
export function useTestDatabase(): TestDatabase {
  const pool = createPool(testDatabaseUrl());
  const db = createDatabase(pool);
  const harness: TestDatabase = {
    pool,
    db,
    repos: createRepositories(db),
    uow: new PgUnitOfWork(db),
  };
  beforeAll(async () => {
    await migrate(pool);
    await resetDatabase(pool);
  });
  afterEach(async () => {
    await resetDatabase(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  return harness;
}
