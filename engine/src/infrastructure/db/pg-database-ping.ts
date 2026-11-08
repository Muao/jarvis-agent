import type pg from 'pg';
import type { DatabasePing } from '../../application/ports/database-ping.js';

/** `SELECT 1` on the pool: proves a connection can be made and a query answered. */
export class PgDatabasePing implements DatabasePing {
  constructor(private readonly pool: pg.Pool) {}

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
}
