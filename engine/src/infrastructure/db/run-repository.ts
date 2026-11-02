import { ROLES, type Role, type RunEvent, type RunStatus } from '@jarvis/shared';
import { and, asc, desc, eq, gt, gte, isNotNull, sql } from 'drizzle-orm';
import type { RunEventBody } from '../../application/ports/agent-runner.js';
import type {
  RunRepository,
  RunTotals,
  UsageBreakdown,
} from '../../application/ports/run-repository.js';
import type { IsoTime, Run } from '../../domain/index.js';
import type { Executor } from './client.js';
import { runEvents, runs } from './schema.js';
import { toDate, toDateOrNull, toIso, toIsoOrNull } from './time.js';

type Row = typeof runs.$inferSelect;

const toDomain = (row: Row): Run => ({
  id: row.id,
  sessionId: row.sessionId,
  role: row.role as Run['role'],
  threadId: row.threadId,
  taskId: row.taskId,
  status: row.status as RunStatus,
  startedAt: toIso(row.startedAt),
  finishedAt: toIsoOrNull(row.finishedAt),
  costUsd: row.costUsd,
  turns: row.turns,
  usage: {
    input: row.tokensInput,
    output: row.tokensOutput,
    cacheRead: row.tokensCacheRead,
    cacheWrite: row.tokensCacheWrite,
  },
  exitCode: row.exitCode,
  error: row.error,
});

/** `ord` is assigned by the database on first insert and never rewritten. */
const toValues = (run: Run): Omit<typeof runs.$inferInsert, 'ord'> => ({
  id: run.id,
  sessionId: run.sessionId,
  role: run.role,
  threadId: run.threadId,
  taskId: run.taskId,
  status: run.status,
  startedAt: toDate(run.startedAt),
  finishedAt: toDateOrNull(run.finishedAt),
  costUsd: run.costUsd,
  turns: run.turns,
  tokensInput: run.usage.input,
  tokensOutput: run.usage.output,
  tokensCacheRead: run.usage.cacheRead,
  tokensCacheWrite: run.usage.cacheWrite,
  exitCode: run.exitCode,
  error: run.error,
});

type EventRow = typeof runEvents.$inferSelect;

const eventToDomain = (row: EventRow): RunEvent =>
  ({
    kind: row.kind,
    payload: row.payload,
    ...(row.parentToolUseId === null ? {} : { parentToolUseId: row.parentToolUseId }),
    seq: row.seq,
    runId: row.runId,
    at: toIso(row.at),
  }) as RunEvent;

export class PgRunRepository implements RunRepository {
  constructor(private readonly db: Executor) {}

  async get(id: string): Promise<Run | null> {
    const [row] = await this.db.select().from(runs).where(eq(runs.id, id));
    return row === undefined ? null : toDomain(row);
  }

  async save(run: Run): Promise<void> {
    const values = toValues(run);
    await this.db.insert(runs).values(values).onConflictDoUpdate({
      target: runs.id,
      set: values,
    });
  }

  async dispatcherBusy(threadId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(eq(runs.threadId, threadId), eq(runs.role, 'dispatcher'), eq(runs.status, 'running')),
      )
      .limit(1);
    return rows.length > 0;
  }

  async listRunning(): Promise<readonly Run[]> {
    const rows = await this.db
      .select()
      .from(runs)
      .where(eq(runs.status, 'running'))
      .orderBy(asc(runs.ord));
    return rows.map(toDomain);
  }

  async listByTask(taskId: string): Promise<readonly Run[]> {
    const rows = await this.db
      .select()
      .from(runs)
      .where(eq(runs.taskId, taskId))
      .orderBy(asc(runs.startedAt), asc(runs.ord));
    return rows.map(toDomain);
  }

  async listBySession(sessionId: string): Promise<readonly Run[]> {
    const rows = await this.db
      .select()
      .from(runs)
      .where(eq(runs.sessionId, sessionId))
      .orderBy(asc(runs.startedAt), asc(runs.ord));
    return rows.map(toDomain);
  }

  async latestOfRole(role: Role): Promise<Run | null> {
    const [row] = await this.db
      .select()
      .from(runs)
      .where(eq(runs.role, role))
      .orderBy(desc(runs.startedAt), desc(runs.ord))
      .limit(1);
    return row === undefined ? null : toDomain(row);
  }

  async totalsByTask(): Promise<ReadonlyMap<string, RunTotals>> {
    const rows = await this.db
      .select({
        taskId: runs.taskId,
        runCount: sql<number>`count(*)::int`,
        costUsd: sql<number>`coalesce(sum(${runs.costUsd}), 0)::float8`,
      })
      .from(runs)
      .where(isNotNull(runs.taskId))
      .groupBy(runs.taskId);
    const totals = new Map<string, RunTotals>();
    for (const { taskId, runCount, costUsd } of rows) {
      if (taskId !== null) totals.set(taskId, { runCount, costUsd });
    }
    return totals;
  }

  async usageSince(since: IsoTime): Promise<UsageBreakdown> {
    const from = gte(runs.startedAt, toDate(since));
    const cost = sql<number>`coalesce(sum(${runs.costUsd}), 0)::float8`;
    const [roleRows, taskRows] = await Promise.all([
      this.db.select({ role: runs.role, costUsd: cost }).from(runs).where(from).groupBy(runs.role),
      this.db
        .select({ taskId: runs.taskId, costUsd: cost })
        .from(runs)
        .where(and(from, isNotNull(runs.taskId)))
        .groupBy(runs.taskId)
        .orderBy(desc(cost), asc(runs.taskId)),
    ]);
    const byRole = Object.fromEntries(ROLES.map((role) => [role, 0])) as Record<Role, number>;
    for (const { role, costUsd } of roleRows) byRole[role as Role] = costUsd;
    return {
      byRole,
      byTask: taskRows.flatMap(({ taskId, costUsd }) =>
        taskId === null ? [] : [{ taskId, costUsd }],
      ),
    };
  }

  async events(runId: string, afterSeq = -1): Promise<readonly RunEvent[]> {
    const rows = await this.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
      .orderBy(asc(runEvents.seq));
    return rows.map(eventToDomain);
  }

  async costSince(since: IsoTime): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<number>`coalesce(sum(${runs.costUsd}), 0)::float8` })
      .from(runs)
      .where(gte(runs.startedAt, toDate(since)));
    return row?.total ?? 0;
  }

  async lastEvent(runId: string): Promise<RunEvent | null> {
    const [row] = await this.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(desc(runEvents.seq))
      .limit(1);
    return row === undefined ? null : eventToDomain(row);
  }

  /**
   * The run's `seq` counts 0, 1, 2, ... A transaction-scoped advisory lock on the run serialises
   * concurrent appenders, so two writers never read the same `max(seq)`. Called on the pool this opens
   * its own short transaction; called inside a unit of work it is a savepoint of that transaction.
   */
  appendEvent(runId: string, body: RunEventBody, at: IsoTime): Promise<RunEvent> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${runId}))`);
      const [last] = await tx
        .select({ seq: sql<number | null>`max(${runEvents.seq})` })
        .from(runEvents)
        .where(eq(runEvents.runId, runId));
      const seq = (last?.seq ?? -1) + 1;
      const [stored] = await tx
        .insert(runEvents)
        .values({
          runId,
          seq,
          kind: body.kind,
          payload: body.payload as Record<string, unknown>,
          parentToolUseId: body.parentToolUseId ?? null,
          at: toDate(at),
        })
        .returning();
      if (stored === undefined) throw new Error('run_events insert returned no row');
      return eventToDomain(stored);
    });
  }
}
