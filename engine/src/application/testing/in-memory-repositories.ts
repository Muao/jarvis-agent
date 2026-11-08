import { ROLES, type Role, type RunEvent, type TaskStage, type UsageGroupBy } from '@jarvis/shared';
import {
  isActive,
  isAnswered,
  isCard,
  type Message,
  type Run,
  type Task,
} from '../../domain/index.js';
import type { RunEventBody } from '../ports/agent-runner.js';
import type {
  RunTotals,
  UsageAggregate,
  UsageBreakdown,
  UsageFigures,
  UsageGroup,
  UsageWindow,
} from '../ports/run-repository.js';
import type { JournalEntry, JournalRepository } from '../ports/journal-repository.js';
import type { MessageRepository } from '../ports/message-repository.js';
import type { PermissionRepository } from '../ports/permission-repository.js';
import type { RunRepository } from '../ports/run-repository.js';
import type { SessionRepository } from '../ports/session-repository.js';
import type { TaskRepository } from '../ports/task-repository.js';
import type { ThreadRepository } from '../ports/thread-repository.js';
import type { Repositories } from '../ports/unit-of-work.js';
import type { WatchRepository } from '../ports/watch-repository.js';
import type { InMemoryDatabase } from './in-memory-database.js';

const byTime = (a: { at: string }, b: { at: string }): number => a.at.localeCompare(b.at);

class InMemoryThreadRepository implements ThreadRepository {
  constructor(private readonly db: InMemoryDatabase) {}
  get = async (id: string) => this.db.tables.threads.get(id) ?? null;
  save = async (thread: Parameters<ThreadRepository['save']>[0]) => {
    this.db.tables.threads.set(thread.id, thread);
  };
  list = async () =>
    [...this.db.tables.threads.values()].sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
}

const isOwnerQueued = (m: Message): boolean => m.kind === 'owner' && m.body.delivery === 'queued';

class InMemoryMessageRepository implements MessageRepository {
  constructor(private readonly db: InMemoryDatabase) {}

  private all(): Message[] {
    return [...this.db.tables.messages.values()];
  }

  get = async (id: string) => this.db.tables.messages.get(id) ?? null;
  add = async (message: Message) => {
    this.db.tables.messages.set(message.id, message);
  };
  save = async (message: Message) => {
    this.db.tables.messages.set(message.id, message);
  };
  permissionCardOf = async (permissionId: string) =>
    this.all().find((m) => m.kind === 'permission' && m.body.permissionId === permissionId) ?? null;
  statusCardOf = async (taskId: string) =>
    this.all().find((m) => m.kind === 'status' && m.taskId === taskId) ?? null;
  openCards = async (taskId: string) =>
    this.all()
      .filter((m) => m.taskId === taskId && isCard(m) && !isAnswered(m))
      .sort(byTime);
  queuedWorkerInput = async (taskId: string) =>
    this.all()
      .filter((m) => m.taskId === taskId && isOwnerQueued(m))
      .sort(byTime);
  queuedDispatcherInput = async (threadId: string) =>
    this.all()
      .filter((m) => m.threadId === threadId && m.taskId === null && isOwnerQueued(m))
      .sort(byTime);
  threadsWithQueuedDispatcherInput = async () => [
    ...new Set(
      this.all()
        .filter((m) => m.taskId === null && isOwnerQueued(m))
        .sort(byTime)
        .map((m) => m.threadId),
    ),
  ];
  listByThread = async (threadId: string) =>
    this.all()
      .filter((m) => m.threadId === threadId)
      .sort(byTime);
  threadsWithOpenCards = async () => [
    ...new Set(
      this.all()
        .filter((m) => isCard(m) && !isAnswered(m))
        .sort(byTime)
        .map((m) => m.threadId),
    ),
  ];
}

class InMemoryTaskRepository implements TaskRepository {
  constructor(private readonly db: InMemoryDatabase) {}
  get = async (id: string) => this.db.tables.tasks.get(id) ?? null;
  save = async (task: Task) => {
    this.db.tables.tasks.set(task.id, task);
  };
  nextId = async () => this.db.nextTaskId();
  activeForThread = async (threadId: string) =>
    [...this.db.tables.tasks.values()].find((t) => t.threadId === threadId && isActive(t)) ?? null;
  listActive = async () =>
    [...this.db.tables.tasks.values()]
      .filter(isActive)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  listAll = async () =>
    [...this.db.tables.tasks.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  listByThread = async (threadId: string) =>
    [...this.db.tables.tasks.values()]
      .filter((t) => t.threadId === threadId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

class InMemoryJournalRepository implements JournalRepository {
  constructor(private readonly db: InMemoryDatabase) {}
  append = async (event: Parameters<JournalRepository['append']>[0]) => {
    this.db.tables.journal.push(event);
  };
  list = async (taskId: string) => this.db.tables.journal.filter((e) => e.taskId === taskId);

  /** `seq` is the 1-based position in the journal, like a bigserial. */
  private numbered(): JournalEntry[] {
    return this.db.tables.journal.map((event, index) => ({ ...event, seq: index + 1 }));
  }

  entries = async (taskId: string) => this.numbered().filter((e) => e.taskId === taskId);
  recent = async (limit: number) => this.numbered().reverse().slice(0, limit);
}

class InMemorySessionRepository implements SessionRepository {
  constructor(private readonly db: InMemoryDatabase) {}
  get = async (id: string) => this.db.tables.sessions.get(id) ?? null;
  save = async (session: Parameters<SessionRepository['save']>[0]) => {
    this.db.tables.sessions.set(session.id, session);
  };
  dispatcherOf = async (threadId: string) =>
    [...this.db.tables.sessions.values()].find(
      (s) => s.role === 'dispatcher' && s.threadId === threadId,
    ) ?? null;
}

class InMemoryRunRepository implements RunRepository {
  constructor(private readonly db: InMemoryDatabase) {}
  get = async (id: string) => this.db.tables.runs.get(id) ?? null;
  save = async (run: Parameters<RunRepository['save']>[0]) => {
    this.db.tables.runs.set(run.id, run);
  };
  listRunning = async () => [...this.db.tables.runs.values()].filter((r) => r.status === 'running');
  listByTask = async (taskId: string) =>
    [...this.db.tables.runs.values()]
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  listBySession = async (sessionId: string) =>
    [...this.db.tables.runs.values()]
      .filter((r) => r.sessionId === sessionId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  latestOfRole = async (role: Role) =>
    [...this.db.tables.runs.values()]
      .filter((r) => r.role === role)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
  totalsByTask = async () => {
    const totals = new Map<string, RunTotals>();
    for (const run of this.db.tables.runs.values()) {
      if (run.taskId === null) continue;
      const known = totals.get(run.taskId) ?? { runCount: 0, costUsd: 0 };
      totals.set(run.taskId, {
        runCount: known.runCount + 1,
        costUsd: known.costUsd + run.costUsd,
      });
    }
    return totals;
  };
  costSince = async (since: string) =>
    [...this.db.tables.runs.values()]
      .filter((r) => r.startedAt >= since)
      .reduce((sum, r) => sum + r.costUsd, 0);
  usageSince = async (since: string): Promise<UsageBreakdown> => {
    const byRole = Object.fromEntries(ROLES.map((role) => [role, 0])) as Record<Role, number>;
    const byTask = new Map<string, number>();
    for (const run of this.db.tables.runs.values()) {
      if (run.startedAt < since) continue;
      byRole[run.role] += run.costUsd;
      if (run.taskId !== null) byTask.set(run.taskId, (byTask.get(run.taskId) ?? 0) + run.costUsd);
    }
    return {
      byRole,
      byTask: [...byTask.entries()]
        .map(([taskId, costUsd]) => ({ taskId, costUsd }))
        .sort((a, b) => b.costUsd - a.costUsd || a.taskId.localeCompare(b.taskId)),
    };
  };
  usageReport = async (window: UsageWindow, groupBy: UsageGroupBy): Promise<UsageAggregate> => {
    // The same grouping the SQL does, written the obvious way so the contract test compares the two.
    interface Part {
      readonly key: string;
      readonly run: Run;
      readonly tokens: Run['usage'];
      readonly costUsd: number;
      readonly turns: number;
      readonly durationMs: number;
    }
    const start = Date.parse(window.from);
    const end = Date.parse(window.to);
    const inWindow = [...this.db.tables.runs.values()].filter((r) => {
      const at = Date.parse(r.startedAt);
      return at >= start && at < end;
    });
    const wholeRun = (run: Run, key: string): Part => ({
      key,
      run,
      tokens: run.usage,
      costUsd: run.costUsd,
      turns: run.turns,
      durationMs:
        run.finishedAt === null ? 0 : Date.parse(run.finishedAt) - Date.parse(run.startedAt),
    });
    const figures = (parts: readonly Part[]): UsageFigures => {
      const stopReasons: Record<string, number> = {};
      const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const part of parts) {
        const reason =
          part.run.status === 'running' ? 'running' : (part.run.stopReason ?? 'unknown');
        stopReasons[reason] = (stopReasons[reason] ?? 0) + 1;
        tokens.input += part.tokens.input;
        tokens.output += part.tokens.output;
        tokens.cacheRead += part.tokens.cacheRead;
        tokens.cacheWrite += part.tokens.cacheWrite;
      }
      return {
        runs: parts.length,
        costUsd: parts.reduce((sum, p) => sum + p.costUsd, 0),
        turns: parts.reduce((sum, p) => sum + p.turns, 0),
        tokens,
        stopReasons,
        durationMs: parts.reduce((sum, p) => sum + p.durationMs, 0),
      };
    };
    const parts: Part[] = inWindow.flatMap((run): Part[] => {
      switch (groupBy) {
        case 'day':
          return [wholeRun(run, run.startedAt.slice(0, 10))];
        case 'session':
          return [wholeRun(run, run.sessionId)];
        case 'task':
          return run.taskId === null ? [] : [wholeRun(run, run.taskId)];
        case 'model':
          return Object.entries(run.modelUsage).map(([model, usage]) => ({
            key: model,
            run,
            tokens: usage,
            costUsd: usage.costUsd,
            turns: 0,
            durationMs: 0,
          }));
      }
    });
    const byKey = new Map<string, Part[]>();
    for (const part of parts) byKey.set(part.key, [...(byKey.get(part.key) ?? []), part]);
    const rows = [...byKey.entries()].map(([key, group]): UsageGroup => {
      const first = group[0]!.run;
      const base = { key, ...figures(group) };
      if (groupBy === 'session') {
        return { ...base, role: first.role, threadId: first.threadId, taskId: first.taskId };
      }
      if (groupBy === 'task') {
        return { ...base, stage: this.db.tables.tasks.get(key)!.stage as TaskStage };
      }
      return base;
    });
    rows.sort((a, b) =>
      groupBy === 'day'
        ? a.key.localeCompare(b.key)
        : b.costUsd - a.costUsd || a.key.localeCompare(b.key),
    );
    return { rows, total: figures(inWindow.map((run) => wholeRun(run, ''))) };
  };
  lastEvent = async (runId: string) => this.db.tables.runEvents.get(runId)?.at(-1) ?? null;
  events = async (runId: string, afterSeq = -1) =>
    (this.db.tables.runEvents.get(runId) ?? []).filter((e) => e.seq > afterSeq);
  appendEvent = async (runId: string, body: RunEventBody, at: string): Promise<RunEvent> => {
    const events = this.db.tables.runEvents.get(runId) ?? [];
    const stored: RunEvent = { ...body, seq: events.length, runId, at };
    this.db.tables.runEvents.set(runId, [...events, stored]);
    return stored;
  };
  dispatcherBusy = async (threadId: string) =>
    [...this.db.tables.runs.values()].some(
      (r) => r.role === 'dispatcher' && r.threadId === threadId && r.status === 'running',
    );
}

class InMemoryPermissionRepository implements PermissionRepository {
  constructor(private readonly db: InMemoryDatabase) {}
  get = async (id: string) => this.db.tables.permissions.get(id) ?? null;
  save = async (request: Parameters<PermissionRepository['save']>[0]) => {
    this.db.tables.permissions.set(request.id, request);
  };
  listPending = async () =>
    [...this.db.tables.permissions.values()]
      .filter((r) => r.status === 'pending')
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

class InMemoryWatchRepository implements WatchRepository {
  constructor(private readonly db: InMemoryDatabase) {}
  get = async (taskId: string) => this.db.tables.watches.get(taskId) ?? null;
  save = async (watch: Parameters<WatchRepository['save']>[0]) => {
    this.db.tables.watches.set(watch.taskId, watch);
  };
  /** Oldest task first, like the Postgres repository. */
  listActive = async () =>
    [...this.db.tables.watches.values()]
      .flatMap((watch) => {
        const task = this.db.tables.tasks.get(watch.taskId);
        return task !== undefined && isActive(task) ? [{ watch, startedAt: task.startedAt }] : [];
      })
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map(({ watch }) => watch);
}

export function inMemoryRepositories(db: InMemoryDatabase): Repositories {
  return {
    threads: new InMemoryThreadRepository(db),
    messages: new InMemoryMessageRepository(db),
    tasks: new InMemoryTaskRepository(db),
    journal: new InMemoryJournalRepository(db),
    sessions: new InMemorySessionRepository(db),
    runs: new InMemoryRunRepository(db),
    permissions: new InMemoryPermissionRepository(db),
    watches: new InMemoryWatchRepository(db),
  };
}
