import { and, asc, desc, eq, gte, inArray } from 'drizzle-orm';
import type {
  JournalEntry,
  JournalRepository,
} from '../../application/ports/journal-repository.js';
import type { EventActor, TaskEvent } from '../../domain/index.js';
import type { Executor } from './client.js';
import { taskEvents } from './schema.js';
import { toDate, toIso } from './time.js';

type Row = typeof taskEvents.$inferSelect;

const toDomain = (row: Row): TaskEvent => ({
  taskId: row.taskId,
  type: row.type,
  at: toIso(row.at),
  actor: row.actor as EventActor,
  data: row.data,
});

const toEntry = (row: Row): JournalEntry => ({ ...toDomain(row), seq: row.seq });

/** Insert and select only: a trigger rejects UPDATE and DELETE on `task_events` (ADR-0008). */
export class PgJournalRepository implements JournalRepository {
  constructor(private readonly db: Executor) {}

  async append(event: TaskEvent): Promise<void> {
    await this.db.insert(taskEvents).values({
      taskId: event.taskId,
      type: event.type,
      at: toDate(event.at),
      actor: event.actor,
      data: event.data as Record<string, unknown>,
    });
  }

  private rowsOf(taskId: string): Promise<Row[]> {
    return this.db
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.taskId, taskId))
      .orderBy(asc(taskEvents.seq));
  }

  async list(taskId: string): Promise<readonly TaskEvent[]> {
    return (await this.rowsOf(taskId)).map(toDomain);
  }

  async entries(taskId: string): Promise<readonly JournalEntry[]> {
    return (await this.rowsOf(taskId)).map(toEntry);
  }

  async ofTypesSince(types: readonly string[], since: string): Promise<readonly TaskEvent[]> {
    if (types.length === 0) return [];
    const rows = await this.db
      .select()
      .from(taskEvents)
      .where(and(inArray(taskEvents.type, [...types]), gte(taskEvents.at, toDate(since))))
      .orderBy(asc(taskEvents.seq));
    return rows.map(toDomain);
  }

  async recent(limit: number): Promise<readonly JournalEntry[]> {
    const rows = await this.db.select().from(taskEvents).orderBy(desc(taskEvents.seq)).limit(limit);
    return rows.map(toEntry);
  }
}
