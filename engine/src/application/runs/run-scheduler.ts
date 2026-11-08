import { canStartRun } from '../../domain/index.js';
import type { BodyOf } from '../conversation/message-bodies.js';
import type { ThreadMessages } from '../conversation/thread-messages.js';
import type { ConnectionChecks } from '../ports/connection-checks.js';
import type { QueuedWorkerRun, RunCoordinator, WorkerRunReason } from '../ports/run-coordinator.js';
import { transact, type Notifiers } from '../transaction.js';
import { startOfLocalDay } from './local-day.js';
import type { LiveRun, LiveRuns } from './live-runs.js';
import { StartRun, type StartRunDeps } from './start-run.js';

export interface RunSchedulerDeps extends Omit<StartRunDeps, 'notifiers'> {
  readonly notifiers: Omit<Notifiers, 'runs'>;
  readonly messages: ThreadMessages;
  readonly liveRuns: LiveRuns;
  /** The last claude probe; a run never starts while it says the login has expired. */
  readonly connections: Pick<ConnectionChecks, 'last'>;
}

type FillResult = 'idle' | 'budget_reached' | 'login_expired';

/**
 * Decides when `claude` processes start (DSP-08, LIM-04, LIM-05).
 *  - Worker work (task start / resume / retry) waits in a FIFO queue for one of
 *    `limits.maxConcurrentWorkers` slots; the limit is read each time a slot is handed out.
 *  - Dispatcher turns take no slot but run one at a time per thread.
 *  - Nothing starts while the last claude probe says the login has expired; the work stays queued
 *    and the thread is told once per day.
 *  - Before every start the day's estimated cost is checked; when the budget is used up nothing
 *    starts, the thread is told once per day, and the work stays queued until `resumeQueued()`.
 * All decisions run one after another, so asking twice can never start two processes.
 */
export class RunScheduler implements RunCoordinator {
  private readonly workerQueue: QueuedWorkerRun[] = [];
  private readonly dispatcherPending = new Set<string>();
  /** Thread id -> the day (local midnight) it was last told the budget is used up. */
  private readonly budgetNoticeDay = new Map<string, string>();
  /** Thread id -> the day it was last told the claude login has expired. */
  private readonly loginNoticeDay = new Map<string, string>();
  private readonly startRun: StartRun;
  private readonly notifiers: Notifiers;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: RunSchedulerDeps) {
    this.notifiers = { ...deps.notifiers, runs: this };
    this.startRun = new StartRun({ ...deps, notifiers: this.notifiers });
  }

  requestDispatcherTurn(threadId: string): Promise<void> {
    return this.exclusive(async () => {
      this.dispatcherPending.add(threadId);
      const result = await this.fill();
      if (result !== 'idle' && this.dispatcherPending.has(threadId)) {
        await this.noticeNotStarted(result, threadId, null);
      }
    });
  }

  /** Start, resume and retry all mean "run this task when a slot is free"; the task's stage tells the worker which. */
  requestWorkerRun(taskId: string, reason: WorkerRunReason = 'start'): Promise<void> {
    return this.exclusive(async () => {
      if (this.positionOf(taskId) >= 0 || this.deps.liveRuns.workerOf(taskId)) return;
      this.workerQueue.push({ taskId, reason, since: this.deps.clock.now() });
      const result = await this.fill();
      const position = this.positionOf(taskId);
      if (position < 0) return;
      const threadId = await this.threadOf(taskId);
      if (threadId === null) return;
      if (result !== 'idle') {
        await this.noticeNotStarted(result, threadId, taskId);
      } else {
        await this.postSystem(threadId, taskId, `Queued — position ${position + 1}`);
      }
    });
  }

  /** Start whatever fits now. Called after a run exits and by the timer that watches the budget. */
  resumeQueued(): Promise<void> {
    return this.exclusive(async () => {
      await this.fill();
    });
  }

  deliverToWorker(taskId: string): Promise<void> {
    return this.exclusive(async () => {
      const live = this.deps.liveRuns.workerOf(taskId);
      if (live?.handle == null) return;
      const { handle } = live;
      await transact(this.tx(), async (tx, outbox) => {
        for (const message of await tx.messages.queuedWorkerInput(taskId)) {
          handle.send(String(message.body.text ?? ''));
          await this.deps.messages.replace(tx, outbox, {
            ...message,
            body: { ...message.body, delivery: 'delivered' },
          });
        }
      });
    });
  }

  async stopTaskRuns(taskId: string): Promise<void> {
    await this.exclusive(async () => {
      const at = this.positionOf(taskId);
      if (at >= 0) this.workerQueue.splice(at, 1);
    });
    // Outside the exclusive section: stopping ends in the run's exit handling, which uses it.
    await this.deps.liveRuns.workerOf(taskId)?.handle?.stop();
  }

  async isQueued(taskId: string): Promise<boolean> {
    return this.positionOf(taskId) >= 0;
  }

  async queueSnapshot(): Promise<readonly QueuedWorkerRun[]> {
    return [...this.workerQueue];
  }

  private positionOf(taskId: string): number {
    return this.workerQueue.findIndex((entry) => entry.taskId === taskId);
  }

  private async runEnded(run: LiveRun): Promise<void> {
    await this.exclusive(async () => {
      // Messages that arrived during a dispatcher turn wait for the next one.
      if (run.role === 'dispatcher') this.dispatcherPending.add(run.threadId);
      await this.fill();
    });
  }

  private async fill(): Promise<FillResult> {
    const { liveRuns, config } = this.deps;
    this.loginExpired();
    for (const threadId of [...this.dispatcherPending]) {
      if (liveRuns.dispatcherOf(threadId) !== undefined) continue;
      if (this.loginExpired()) return 'login_expired';
      if (!(await this.budgetLeft())) return 'budget_reached';
      this.dispatcherPending.delete(threadId);
      await this.attempt(threadId, null, () =>
        this.startRun.dispatcher(threadId, (run) => this.runEnded(run)),
      );
    }
    while (
      this.workerQueue.length > 0 &&
      liveRuns.workerCount() < config.current().limits.maxConcurrentWorkers
    ) {
      if (this.loginExpired()) return 'login_expired';
      if (!(await this.budgetLeft())) return 'budget_reached';
      const taskId = this.workerQueue.shift()?.taskId;
      if (taskId === undefined) break;
      const threadId = await this.threadOf(taskId);
      if (threadId === null) continue;
      await this.attempt(threadId, taskId, () =>
        this.startRun.worker(taskId, (run) => this.runEnded(run)),
      );
    }
    return 'idle';
  }

  private async attempt(
    threadId: string,
    taskId: string | null,
    start: () => Promise<boolean>,
  ): Promise<void> {
    try {
      await start();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.notifiers.logger.error('could not start run', { threadId, taskId, error: reason });
      await this.postSystem(threadId, taskId, `Could not start the run: ${reason}`);
    }
  }

  private async budgetLeft(): Promise<boolean> {
    const { uow, clock, config } = this.deps;
    const spent = await uow.run((tx) => tx.runs.costSince(startOfLocalDay(clock.now())));
    return canStartRun(spent, config.current().limits).ok;
  }

  private loginExpired(): boolean {
    const expired = this.deps.connections.last('claude')?.loginExpired === true;
    // A recurrence of the expiry later the same day must tell the threads again.
    if (!expired) this.loginNoticeDay.clear();
    return expired;
  }

  private noticeNotStarted(
    reason: Exclude<FillResult, 'idle'>,
    threadId: string,
    taskId: string | null,
  ): Promise<void> {
    return reason === 'login_expired'
      ? this.noticeLoginExpired(threadId, taskId)
      : this.noticeBudgetReached(threadId, taskId);
  }

  /** Once per day and thread, like the budget notice. */
  private async noticeLoginExpired(threadId: string, taskId: string | null): Promise<void> {
    const day = startOfLocalDay(this.deps.clock.now());
    if (this.loginNoticeDay.get(threadId) === day) return;
    this.loginNoticeDay.set(threadId, day);
    await this.postSystem(
      threadId,
      taskId,
      'The claude login has expired. Nothing new starts; queued work resumes once you log in again (run `claude` and /login on the machine).',
    );
  }

  /** LIM-04: once per day and thread, so a busy queue does not flood the chat. */
  private async noticeBudgetReached(threadId: string, taskId: string | null): Promise<void> {
    const day = startOfLocalDay(this.deps.clock.now());
    if (this.budgetNoticeDay.get(threadId) === day) return;
    this.budgetNoticeDay.set(threadId, day);
    const budget = this.deps.config.current().limits.dailyBudgetUsd;
    await this.postSystem(
      threadId,
      taskId,
      `Daily budget of $${budget} is used up. Nothing new starts; queued work resumes tomorrow or when the budget is raised.`,
    );
  }

  private async threadOf(taskId: string): Promise<string | null> {
    const task = await this.deps.uow.run((tx) => tx.tasks.get(taskId));
    return task?.threadId ?? null;
  }

  private async postSystem(threadId: string, taskId: string | null, text: string): Promise<void> {
    const body: BodyOf<'system'> = { text };
    try {
      await transact(this.tx(), (tx, outbox) =>
        this.deps.messages.post(tx, outbox, { threadId, taskId, kind: 'system', body }),
      );
    } catch (error) {
      this.deps.notifiers.logger.error('could not post a system message', {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private tx(): { uow: StartRunDeps['uow']; notifiers: Notifiers } {
    return { uow: this.deps.uow, notifiers: this.notifiers };
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
