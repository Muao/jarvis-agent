import { fileURLToPath } from 'node:url';
import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import { migrate as runMigrations } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import pg from 'pg';

/** Anything queries run on: the pool-backed database or a transaction (both are a `PgDatabase`). */
export type Executor = PgDatabase<NodePgQueryResultHKT>;

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../drizzle', import.meta.url));

/** The caller reads the URL (from config or env); this module never touches `process.env`. */
export function createPool(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  // An idle client dying (e.g. the container restarts) must not crash the process; the next query reconnects.
  pool.on('error', () => undefined);
  return pool;
}

export function createDatabase(pool: pg.Pool): NodePgDatabase {
  return drizzle(pool);
}

/** Apply pending migrations from `engine/drizzle`. Safe to call on every start. */
export async function migrate(pool: pg.Pool): Promise<void> {
  await runMigrations(createDatabase(pool), { migrationsFolder: MIGRATIONS_FOLDER });
}
