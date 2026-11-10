import {
  ROLES,
  type Role,
  type RunEvent,
  type RunStatus,
  type StopReason,
  type TaskStage,
  type UsageGroupBy,
} from '@jarvis/shared';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import type { RunEventBody } from '../../application/ports/agent-runner.js';
import type {
  RunRepository,
  RunTotals,
  UsageAggregate,
  UsageBreakdown,
  UsageFigures,
  UsageGroup,
  UsageWindow,
} from '../../application/ports/run-repository.js';
import type { IsoTime, Run } from '../../domain/index.js';
import type { Executor } from './client.js';
import { runEvents, runs } from './schema.js';
import { toDate, toDateOrNull, toIso, toIsoOrNull } from './time.js';

type Row = typeof runs.$inferSelect;

/** Replaced by the bound window predicate (see `usageReport`); values never enter the SQL text. */
const IN_WINDOW = '__WINDOW__';

/** One row per run (or per run and model) with the columns every grouping shares; `r` is `runs`. */
const RUN_COLUMNS = `
  r.cost_usd as cost, r.turns as turns,
  r.tokens_input as t_in, r.tokens_output as t_out,
  r.tokens_cache_read as t_cr, r.tokens_cache_write as t_cw,
  case when r.finished_at is null then 0
       else extract(epoch from (r.finished_at - r.started_at)) * 1000 end as dur,
  case when r.status = 'running' then 'running' else coalesce(r.stop_reason, 'unknown') end as reason`;

const NO_META = `null::text as role, null::text as thread_id, null::text as task_id, null::text as stage`;

/**
 * The per-run source of a report. `model` unnests the `model_usage` jsonb with `jsonb_each` (a lateral
 * join): one row per run and model, with that model's own tokens and cost. Turns and duration are
 * per run, not per model, so those rows carry 0 rather than a figure counted once per model.
 */
function usageSource(groupBy: UsageGroupBy | 'total'): string {
  switch (groupBy) {
    case 'total':
      return `select '' as key, ${NO_META}, ${RUN_COLUMNS} from runs r where ${IN_WINDOW}`;
    case 'day':
      return `select to_char(r.started_at at time zone 'UTC', 'YYYY-MM-DD') as key, ${NO_META}, ${RUN_COLUMNS}
        from runs r where ${IN_WINDOW}`;
    case 'session':
      return `select r.session_id as key, r.role as role, r.thread_id as thread_id, r.task_id as task_id,
        null::text as stage, ${RUN_COLUMNS} from runs r where ${IN_WINDOW}`;
    case 'task':
      return `select r.task_id as key, null::text as role, null::text as thread_id, null::text as task_id,
        t.stage as stage, ${RUN_COLUMNS} from runs r join tasks t on t.id = r.task_id where ${IN_WINDOW}`;
    case 'model':
      return `select m.key as key, ${NO_META},
        (m.value->>'costUsd')::float8 as cost, 0 as turns,
        (m.value->>'input')::bigint as t_in, (m.value->>'output')::bigint as t_out,
        (m.value->>'cacheRead')::bigint as t_cr, (m.value->>'cacheWrite')::bigint as t_cw,
        0 as dur,
        case when r.status = 'running' then 'running' else coalesce(r.stop_reason, 'unknown') end as reason
        from runs r cross join lateral jsonb_each(r.model_usage) as m(key, value) where ${IN_WINDOW}`;
  }
}

/** Groups by (key, reason) first so the reasons fold into one jsonb object per key. */
const AGGREGATE = (source: string, order: string): string => `
  with src as (${source}),
  by_reason as (
    select key, reason, max(role) as role, max(thread_id) as thread_id, max(task_id) as task_id,
      max(stage) as stage, count(*) as n, sum(cost) as cost, sum(turns) as turns,
      sum(t_in) as t_in, sum(t_out) as t_out, sum(t_cr) as t_cr, sum(t_cw) as t_cw, sum(dur) as dur
    from src group by key, reason
  )
  select key, max(role) as role, max(thread_id) as thread_id, max(task_id) as task_id, max(stage) as stage,
    sum(n)::int as runs, coalesce(sum(cost), 0)::float8 as cost_usd, coalesce(sum(turns), 0)::int as turns,
    coalesce(sum(t_in), 0)::float8 as t_in, coalesce(sum(t_out), 0)::float8 as t_out,
    coalesce(sum(t_cr), 0)::float8 as t_cr, coalesce(sum(t_cw), 0)::float8 as t_cw,
    coalesce(sum(dur), 0)::float8 as dur,
    jsonb_object_agg(reason, n) as stop_reasons
  from by_reason group by key ${order}`;

type AggregateRow = {
  readonly key: string;
  readonly role: string | null;
  readonly thread_id: string | null;
  readonly task_id: string | null;
  readonly stage: string | null;
  readonly runs: number;
  readonly cost_usd: number;
  readonly turns: number;
  readonly t_in: number;
  readonly t_out: number;
  readonly t_cr: number;
  readonly t_cw: number;
  readonly dur: number;
  readonly stop_reasons: Record<string, number>;
};

const figuresOf = (row: AggregateRow): UsageFigures => ({
  runs: row.runs,
  costUsd: row.cost_usd,
  turns: row.turns,
  tokens: { input: row.t_in, output: row.t_out, cacheRead: row.t_cr, cacheWrite: row.t_cw },
  stopReasons: row.stop_reasons,
  durationMs: Math.round(row.dur),
});

const ORDER_BY: Record<UsageGroupBy, string> = {
  day: 'order by key asc',
  session: 'order by cost_usd desc, key asc',
  task: 'order by cost_usd desc, key asc',
  model: 'order by cost_usd desc, key asc',
};

const groupOf = (groupBy: UsageGroupBy, row: AggregateRow): UsageGroup => {
  const figures = figuresOf(row);
  if (groupBy === 'session') {
    return {
      key: row.key,
      ...figures,
      role: row.role as Role,
      threadId: row.thread_id ?? '',
      taskId: row.task_id,
    };
  }
  if (groupBy === 'task') return { key: row.key, ...figures, stage: row.stage as TaskStage };
  return { key: row.key, ...figures };
};

const EMPTY_FIGURES: UsageFigures = {
  runs: 0,
  costUsd: 0,
  turns: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  stopReasons: {},
  durationMs: 0,
};

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
  stopReason: row.stopReason as StopReason | null,
  modelUsage: row.modelUsage,
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
  stopReason: run.stopReason,
  modelUsage: run.modelUsage,
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

  async usageReport(window: UsageWindow, groupBy: UsageGroupBy): Promise<UsageAggregate> {
    const inWindow = sql`r.started_at >= ${toDate(window.from)} and r.started_at < ${toDate(window.to)}`;
    const query = (text: string) =>
      this.db.execute<AggregateRow>(
        sql.join(
          text.split(IN_WINDOW).map((chunk) => sql.raw(chunk)),
          inWindow,
        ),
      );
    const [grouped, total] = await Promise.all([
      query(AGGREGATE(usageSource(groupBy), ORDER_BY[groupBy])),
      query(AGGREGATE(usageSource('total'), '')),
    ]);
    const [totalRow] = total.rows;
    return {
      rows: grouped.rows.map((row) => groupOf(groupBy, row)),
      total: totalRow === undefined ? EMPTY_FIGURES : figuresOf(totalRow),
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

  async lastEventsOfKinds(
    runId: string,
    kinds: readonly RunEvent['kind'][],
    limit: number,
  ): Promise<readonly RunEvent[]> {
    if (kinds.length === 0 || limit <= 0) return [];
    const rows = await this.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), inArray(runEvents.kind, [...kinds])))
      .orderBy(desc(runEvents.seq))
      .limit(limit);
    return rows.map(eventToDomain);
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
