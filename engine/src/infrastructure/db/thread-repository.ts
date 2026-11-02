import { asc, desc, eq } from 'drizzle-orm';
import type { ThreadRepository } from '../../application/ports/thread-repository.js';
import type { Thread } from '../../domain/index.js';
import type { Executor } from './client.js';
import { threads } from './schema.js';
import { toDate, toIso } from './time.js';

type Row = typeof threads.$inferSelect;

const toDomain = (row: Row): Thread => ({
  id: row.id,
  title: row.title,
  createdAt: toIso(row.createdAt),
  updatedAt: toIso(row.updatedAt),
});

const toRow = (thread: Thread): Row => ({
  id: thread.id,
  title: thread.title,
  createdAt: toDate(thread.createdAt),
  updatedAt: toDate(thread.updatedAt),
});

export class PgThreadRepository implements ThreadRepository {
  constructor(private readonly db: Executor) {}

  async get(id: string): Promise<Thread | null> {
    const [row] = await this.db.select().from(threads).where(eq(threads.id, id));
    return row === undefined ? null : toDomain(row);
  }

  async list(): Promise<readonly Thread[]> {
    const rows = await this.db
      .select()
      .from(threads)
      .orderBy(desc(threads.updatedAt), asc(threads.id));
    return rows.map(toDomain);
  }

  async save(thread: Thread): Promise<void> {
    const values = toRow(thread);
    await this.db.insert(threads).values(values).onConflictDoUpdate({
      target: threads.id,
      set: values,
    });
  }
}
