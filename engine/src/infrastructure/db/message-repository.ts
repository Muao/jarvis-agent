import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { MessageRepository } from '../../application/ports/message-repository.js';
import type { Message } from '../../domain/index.js';
import type { Executor } from './client.js';
import { messages } from './schema.js';
import { toDate, toDateOrNull, toIso, toIsoOrNull } from './time.js';

type Row = typeof messages.$inferSelect;

const toDomain = (row: Row): Message => ({
  id: row.id,
  threadId: row.threadId,
  taskId: row.taskId,
  kind: row.kind as Message['kind'],
  body: row.body,
  at: toIso(row.at),
  answer: row.answer,
  answeredAt: toIsoOrNull(row.answeredAt),
});

/** `ord` is assigned by the database on first insert and never rewritten. */
const toValues = (message: Message): Omit<typeof messages.$inferInsert, 'ord'> => ({
  id: message.id,
  threadId: message.threadId,
  taskId: message.taskId,
  kind: message.kind,
  body: message.body as Record<string, unknown>,
  at: toDate(message.at),
  answer: message.answer as Record<string, unknown> | null,
  answeredAt: toDateOrNull(message.answeredAt),
});

const CARD_KINDS = ['decision', 'question', 'permission'];

/** An owner message that no run has taken yet (`body.delivery === 'queued'`). */
const ownerQueued = and(eq(messages.kind, 'owner'), sql`${messages.body}->>'delivery' = 'queued'`);

export class PgMessageRepository implements MessageRepository {
  constructor(private readonly db: Executor) {}

  private async many(where: SQL | undefined): Promise<readonly Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(where)
      .orderBy(asc(messages.at), asc(messages.ord));
    return rows.map(toDomain);
  }

  private async first(where: SQL | undefined): Promise<Message | null> {
    const [row] = await this.db
      .select()
      .from(messages)
      .where(where)
      .orderBy(asc(messages.ord))
      .limit(1);
    return row === undefined ? null : toDomain(row);
  }

  get(id: string): Promise<Message | null> {
    return this.first(eq(messages.id, id));
  }

  async add(message: Message): Promise<void> {
    await this.save(message);
  }

  async save(message: Message): Promise<void> {
    const values = toValues(message);
    await this.db.insert(messages).values(values).onConflictDoUpdate({
      target: messages.id,
      set: values,
    });
  }

  statusCardOf(taskId: string): Promise<Message | null> {
    return this.first(and(eq(messages.kind, 'status'), eq(messages.taskId, taskId)));
  }

  openCards(taskId: string): Promise<readonly Message[]> {
    return this.many(
      and(
        eq(messages.taskId, taskId),
        inArray(messages.kind, CARD_KINDS),
        isNull(messages.answeredAt),
      ),
    );
  }

  permissionCardOf(permissionId: string): Promise<Message | null> {
    return this.first(
      and(
        eq(messages.kind, 'permission'),
        sql`${messages.body}->>'permissionId' = ${permissionId}`,
      ),
    );
  }

  queuedWorkerInput(taskId: string): Promise<readonly Message[]> {
    return this.many(and(eq(messages.taskId, taskId), ownerQueued));
  }

  queuedDispatcherInput(threadId: string): Promise<readonly Message[]> {
    return this.many(and(eq(messages.threadId, threadId), isNull(messages.taskId), ownerQueued));
  }

  listByThread(threadId: string): Promise<readonly Message[]> {
    return this.many(eq(messages.threadId, threadId));
  }

  async threadsWithOpenCards(): Promise<readonly string[]> {
    const rows = await this.db
      .select({ threadId: messages.threadId })
      .from(messages)
      .where(and(inArray(messages.kind, CARD_KINDS), isNull(messages.answeredAt)))
      .groupBy(messages.threadId)
      .orderBy(asc(sql`min(${messages.at})`), asc(sql`min(${messages.ord})`));
    return rows.map((row) => row.threadId);
  }

  async threadsWithQueuedDispatcherInput(): Promise<readonly string[]> {
    const rows = await this.db
      .select({ threadId: messages.threadId })
      .from(messages)
      .where(and(isNull(messages.taskId), ownerQueued))
      .groupBy(messages.threadId)
      .orderBy(asc(sql`min(${messages.at})`), asc(sql`min(${messages.ord})`));
    return rows.map((row) => row.threadId);
  }
}
