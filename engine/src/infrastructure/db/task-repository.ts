import { asc, eq, notInArray, and, sql } from 'drizzle-orm';
import type { TaskKind, TaskModel, TaskStage } from '@jarvis/shared';
import type { TaskRepository } from '../../application/ports/task-repository.js';
import { TERMINAL, type Task } from '../../domain/index.js';
import type { Executor } from './client.js';
import { tasks } from './schema.js';
import { toDate, toIso } from './time.js';

type Row = typeof tasks.$inferSelect;

const toDomain = (row: Row): Task => ({
  id: row.id,
  threadId: row.threadId,
  title: row.title,
  kind: row.kind as TaskKind,
  stage: row.stage as TaskStage,
  resumeStage: row.resumeStage as TaskStage | null,
  branch: row.branch,
  pr: row.prNumber === null || row.prUrl === null ? null : { number: row.prNumber, url: row.prUrl },
  counters: {
    checkRetries: row.checkRetries,
    ciFixRounds: row.ciFixRounds,
    reviewRounds: row.reviewRounds,
  },
  workerSessionId: row.workerSessionId,
  startedAt: toIso(row.startedAt),
  updatedAt: toIso(row.updatedAt),
  reason: row.reason,
  targetRepo:
    row.targetRepoOwner === null || row.targetRepoName === null
      ? null
      : { owner: row.targetRepoOwner, name: row.targetRepoName },
  held: row.held,
  model: row.model as TaskModel | null,
});

/** `ord` is assigned by the database on first insert and never rewritten. */
const toValues = (task: Task): Omit<typeof tasks.$inferInsert, 'ord'> => ({
  id: task.id,
  threadId: task.threadId,
  title: task.title,
  kind: task.kind,
  stage: task.stage,
  resumeStage: task.resumeStage,
  branch: task.branch,
  prNumber: task.pr?.number ?? null,
  prUrl: task.pr?.url ?? null,
  checkRetries: task.counters.checkRetries,
  ciFixRounds: task.counters.ciFixRounds,
  reviewRounds: task.counters.reviewRounds,
  workerSessionId: task.workerSessionId,
  startedAt: toDate(task.startedAt),
  updatedAt: toDate(task.updatedAt),
  reason: task.reason,
  targetRepoOwner: task.targetRepo?.owner ?? null,
  targetRepoName: task.targetRepo?.name ?? null,
  held: task.held,
  model: task.model,
});

const active = notInArray(tasks.stage, [...TERMINAL]);

export class PgTaskRepository implements TaskRepository {
  constructor(private readonly db: Executor) {}

  async get(id: string): Promise<Task | null> {
    const [row] = await this.db.select().from(tasks).where(eq(tasks.id, id));
    return row === undefined ? null : toDomain(row);
  }

  async save(task: Task): Promise<void> {
    const values = toValues(task);
    await this.db.insert(tasks).values(values).onConflictDoUpdate({
      target: tasks.id,
      set: values,
    });
  }

  async nextId(): Promise<string> {
    const result = await this.db.execute<{ n: string }>(sql`select nextval('task_ids')::text as n`);
    const row = result.rows[0];
    if (row === undefined) throw new Error('task_ids sequence returned no value');
    return `T-${row.n}`;
  }

  async activeForThread(threadId: string): Promise<Task | null> {
    const [row] = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.threadId, threadId), active))
      .orderBy(asc(tasks.ord))
      .limit(1);
    return row === undefined ? null : toDomain(row);
  }

  async listActive(): Promise<readonly Task[]> {
    const rows = await this.db
      .select()
      .from(tasks)
      .where(active)
      .orderBy(asc(tasks.startedAt), asc(tasks.ord));
    return rows.map(toDomain);
  }

  async listAll(): Promise<readonly Task[]> {
    const rows = await this.db.select().from(tasks).orderBy(asc(tasks.startedAt), asc(tasks.ord));
    return rows.map(toDomain);
  }

  async listByThread(threadId: string): Promise<readonly Task[]> {
    const rows = await this.db
      .select()
      .from(tasks)
      .where(eq(tasks.threadId, threadId))
      .orderBy(asc(tasks.startedAt), asc(tasks.ord));
    return rows.map(toDomain);
  }
}
