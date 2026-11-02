import { and, asc, eq } from 'drizzle-orm';
import type { Role } from '@jarvis/shared';
import type { Session, SessionRepository } from '../../application/ports/session-repository.js';
import type { Executor } from './client.js';
import { sessions } from './schema.js';

type Row = typeof sessions.$inferSelect;

const toDomain = (row: Row): Session => ({
  id: row.id,
  role: row.role as Role,
  threadId: row.threadId,
  taskId: row.taskId,
  claudeSessionId: row.claudeSessionId,
});

export class PgSessionRepository implements SessionRepository {
  constructor(private readonly db: Executor) {}

  async get(id: string): Promise<Session | null> {
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, id));
    return row === undefined ? null : toDomain(row);
  }

  async save(session: Session): Promise<void> {
    await this.db.insert(sessions).values(session).onConflictDoUpdate({
      target: sessions.id,
      set: session,
    });
  }

  async dispatcherOf(threadId: string): Promise<Session | null> {
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.threadId, threadId), eq(sessions.role, 'dispatcher')))
      .orderBy(asc(sessions.id))
      .limit(1);
    return row === undefined ? null : toDomain(row);
  }
}
