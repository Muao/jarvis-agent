import type { OverviewDto, RunEvent } from '@jarvis/shared';
import { isActive, isStalled, toMs, type Run, type Task } from '../../domain/index.js';
import type { Clock } from '../ports/clock.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { QueuedWorkerRun, RunCoordinator } from '../ports/run-coordinator.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { usageWindowStart } from '../runs/usage-window.js';
import { describeJournalEvent } from './journal-text.js';
import { ciStatusOf } from './pull-request.js';
import { describeActivity } from './run-activity.js';
import { usageOf } from './usage.js';
import { currentTaskOf, threadNeedsOwner } from './waiting.js';

const RECENT_EVENTS = 100;
const WATCHED_STAGES: readonly Task['stage'][] = ['PR Open', 'Blocked'];

type Worker = OverviewDto['workers'][number];
type Dispatcher = OverviewDto['dispatcher'];
type Queued = OverviewDto['queue'][number];

function queuedWhat(entry: QueuedWorkerRun, task: Task | undefined): Queued['what'] {
  if (entry.reason === 'start') return 'new_task';
  // A resumed task in Fixing was woken by CI or review; any other resume follows an owner answer.
  return entry.reason === 'resume' && task?.stage === 'Fixing' ? 'ci_event' : 'owner_reply';
}

/** `GET /api/overview`: the Mission Control screen in one read. */
export class GetOverview {
  constructor(
    private readonly deps: {
      readonly uow: UnitOfWork;
      readonly runs: RunCoordinator;
      readonly config: ConfigProvider;
      readonly clock: Clock;
    },
  ) {}

  async execute(): Promise<OverviewDto> {
    const { limits, watch: watchConfig } = this.deps.config.current();
    const now = this.deps.clock.now();
    const queue = await this.deps.runs.queueSnapshot();
    const data = await this.deps.uow.run(async (tx) => {
      const running = await tx.runs.listRunning();
      return {
        spent: await tx.runs.tokensSince(await usageWindowStart(tx, now)),
        running,
        lastEvents: new Map<string, RunEvent | null>(
          await Promise.all(
            running.map(async (run) => [run.id, await tx.runs.lastEvent(run.id)] as const),
          ),
        ),
        awaitingOwner: new Set((await tx.permissions.listPending()).map((p) => p.runId)),
        latestDispatcher: await tx.runs.latestOfRole('dispatcher'),
        tasks: await tx.tasks.listAll(),
        withCards: new Set(await tx.messages.threadsWithOpenCards()),
        watches: await tx.watches.listActive(),
        recent: await tx.journal.recent(RECENT_EVENTS),
      };
    });
    const tasks = new Map(data.tasks.map((task) => [task.id, task]));
    const activity = (run: Run): string => describeActivity(data.lastEvents.get(run.id) ?? null);

    const workers = data.running
      .filter((run) => run.role === 'worker')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .flatMap((run): Worker[] => {
        const task = run.taskId === null ? undefined : tasks.get(run.taskId);
        if (task === undefined) return [];
        const lastAt = data.lastEvents.get(run.id)?.at ?? run.startedAt;
        return [
          {
            // A paused budget stops new starts only; a run that is already going is not paused.
            state: data.awaitingOwner.has(run.id)
              ? 'waiting_for_permission'
              : isStalled(lastAt, now, limits)
                ? 'stalled'
                : 'busy',
            taskId: task.id,
            title: task.title,
            stage: task.stage,
            action: activity(run),
            startedAt: run.startedAt,
            sessionId: run.sessionId,
            // The cost is stored when the run ends, so a live run shows 0.
            runCostUsd: run.costUsd,
          },
        ];
      });
    const free: Worker[] = Array.from(
      { length: Math.max(0, limits.maxConcurrentWorkers - workers.length) },
      () => ({ state: 'free' }),
    );

    const threadsByTask = new Map<string, Task[]>();
    for (const task of data.tasks) {
      threadsByTask.set(task.threadId, [...(threadsByTask.get(task.threadId) ?? []), task]);
    }
    // Threads with an unanswered card (a dispatcher permission has no task) plus threads whose task only the owner can move.
    const needingOwner = new Set(data.withCards);
    for (const [threadId, threadTasks] of threadsByTask) {
      if (threadNeedsOwner(currentTaskOf(threadTasks), false)) needingOwner.add(threadId);
    }

    return {
      usage: usageOf(data.spent, limits, now),
      dispatcher: this.dispatcher(data, activity),
      workers: [...workers, ...free],
      queue: queue.map((entry, index) => ({
        taskId: entry.taskId,
        what: queuedWhat(entry, tasks.get(entry.taskId)),
        since: entry.since,
        position: index + 1,
      })),
      watching: data.watches.flatMap((watch): OverviewDto['watching'] => {
        const task = tasks.get(watch.taskId);
        if (task?.pr == null || !WATCHED_STAGES.includes(task.stage)) return [];
        return [
          {
            taskId: task.id,
            stage: task.stage,
            prUrl: task.pr.url,
            ci: ciStatusOf(watch.summary),
            review: watch.summary?.review ?? null,
            lastCheckedAt: watch.lastCheckedAt,
            nextCheckAt:
              watch.lastCheckedAt === null
                ? null
                : new Date(
                    toMs(watch.lastCheckedAt) + watchConfig.pollSeconds * 1000,
                  ).toISOString(),
          },
        ];
      }),
      waitingForOwner: needingOwner.size,
      prsOpen: data.tasks.filter((task) => isActive(task) && task.pr !== null).length,
      events: data.recent.map((entry) => {
        const { text, group } = describeJournalEvent(entry);
        return { id: String(entry.seq), at: entry.at, taskId: entry.taskId, type: group, text };
      }),
    };
  }

  private dispatcher(
    data: {
      running: readonly Run[];
      awaitingOwner: ReadonlySet<string>;
      latestDispatcher: Run | null;
    },
    activity: (run: Run) => string,
  ): Dispatcher {
    const live = data.running
      .filter((run) => run.role === 'dispatcher')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const focus = live.find((run) => data.awaitingOwner.has(run.id)) ?? live[0];
    if (focus === undefined) {
      const last = data.latestDispatcher;
      return {
        status: last?.status === 'failed' ? 'error' : 'idle',
        action: null,
        runningSince: null,
        sessionId: last?.sessionId ?? null,
      };
    }
    return {
      status: data.awaitingOwner.has(focus.id) ? 'waiting_for_permission' : 'running',
      action: activity(focus),
      runningSince: focus.startedAt,
      sessionId: focus.sessionId,
    };
  }
}
