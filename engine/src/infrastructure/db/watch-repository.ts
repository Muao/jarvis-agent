import { asc, eq, notInArray } from 'drizzle-orm';
import type { Watch, WatchRepository } from '../../application/ports/watch-repository.js';
import { TERMINAL, type WatchState } from '../../domain/index.js';
import type { Executor } from './client.js';
import { tasks, watches } from './schema.js';
import { toDateOrNull, toIsoOrNull } from './time.js';

type Row = typeof watches.$inferSelect;

// `state`, `summary` and `lastGreen` are written only by `toValues`, so reading them back is a cast.
const toDomain = (row: Row): Watch => ({
  taskId: row.taskId,
  prNumber: row.prNumber,
  state: row.state as WatchState | null,
  lastCheckedAt: toIsoOrNull(row.lastCheckedAt),
  summary: row.summary as Watch['summary'],
  lastGreen: row.lastGreen as Watch['lastGreen'],
  rerunHeadSha: row.rerunHeadSha,
});

const toValues = (watch: Watch): typeof watches.$inferInsert => ({
  taskId: watch.taskId,
  prNumber: watch.prNumber,
  state: watch.state,
  lastCheckedAt: toDateOrNull(watch.lastCheckedAt),
  summary: watch.summary,
  lastGreen: watch.lastGreen,
  rerunHeadSha: watch.rerunHeadSha,
});

export class PgWatchRepository implements WatchRepository {
  constructor(private readonly db: Executor) {}

  async get(taskId: string): Promise<Watch | null> {
    const [row] = await this.db.select().from(watches).where(eq(watches.taskId, taskId));
    return row === undefined ? null : toDomain(row);
  }

  async save(watch: Watch): Promise<void> {
    const values = toValues(watch);
    await this.db.insert(watches).values(values).onConflictDoUpdate({
      target: watches.taskId,
      set: values,
    });
  }

  async listActive(): Promise<readonly Watch[]> {
    const rows = await this.db
      .select({ watch: watches })
      .from(watches)
      .innerJoin(tasks, eq(tasks.id, watches.taskId))
      .where(notInArray(tasks.stage, [...TERMINAL]))
      .orderBy(asc(tasks.startedAt), asc(tasks.ord));
    return rows.map((row) => toDomain(row.watch));
  }
}
