import { finishRun, type Run, type RunOutcome } from '../../domain/index.js';
import type { ThreadMessages } from '../conversation/thread-messages.js';
import type { BodyOf } from '../conversation/message-bodies.js';
import type { Clock } from '../ports/clock.js';
import type { RunEventBody, RunListener } from '../ports/agent-runner.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { transact, type Notifiers } from '../transaction.js';
import type { LiveRun, LiveRuns } from './live-runs.js';
import type { RunEventLog } from './run-event-log.js';
import type { RunRegistry } from './run-registry.js';

export interface RunSinkDeps {
  readonly uow: UnitOfWork;
  readonly notifiers: Notifiers;
  readonly clock: Clock;
  readonly messages: ThreadMessages;
  readonly eventLog: RunEventLog;
  readonly registry: RunRegistry;
  readonly liveRuns: LiveRuns;
  /** The run is over and its slot is free. */
  readonly onEnded: (run: LiveRun) => Promise<void>;
}

/**
 * Receives what one `claude` process reports and turns it into stored events, the session id and
 * the finished run. A failure here is logged and never reaches the runner; calls are handled in
 * the order they arrive even if the adapter does not wait for them.
 */
export class RunSink implements RunListener {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: RunSinkDeps,
    private readonly live: LiveRun,
    private readonly sessionId: string,
  ) {}

  event(body: RunEventBody): Promise<void> {
    return this.enqueue('event', async () => {
      await this.deps.eventLog.append(this.live.runId, body);
    });
  }

  session(claudeSessionId: string): Promise<void> {
    return this.enqueue('session', () =>
      this.deps.uow.run(async (tx) => {
        const session = await tx.sessions.get(this.sessionId);
        if (session !== null) await tx.sessions.save({ ...session, claudeSessionId });
      }),
    );
  }

  exit(outcome: RunOutcome): Promise<void> {
    return this.enqueue('exit', () => this.finish(outcome));
  }

  private enqueue(what: string, work: () => Promise<void>): Promise<void> {
    const next = this.tail.then(work).catch((error: unknown) => {
      this.deps.notifiers.logger.error(`run ${what} handling failed`, {
        runId: this.live.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.tail = next;
    return next;
  }

  private async finish(outcome: RunOutcome): Promise<void> {
    const { uow, clock, registry, liveRuns, onEnded } = this.deps;
    registry.revoke(this.live.token);
    try {
      const finished = await uow.run(async (tx) => {
        const run = await tx.runs.get(this.live.runId);
        if (run === null || run.status !== 'running') return null;
        const done = finishRun(run, outcome, clock.now());
        await tx.runs.save(done);
        return done;
      });
      if (finished !== null) await this.announce(finished);
    } finally {
      liveRuns.remove(this.live.runId);
      await onEnded(this.live);
    }
  }

  private async announce(run: Run): Promise<void> {
    const { notifiers, messages } = this.deps;
    notifiers.logger.info(`run ${run.id} ${run.status}`, {
      event: 'run.finished',
      runId: run.id,
      sessionId: run.sessionId,
      ...(run.taskId === null ? {} : { taskId: run.taskId }),
      threadId: run.threadId,
      role: run.role,
      costUsd: run.costUsd,
      turns: run.turns,
      durationMs:
        run.finishedAt === null ? 0 : Date.parse(run.finishedAt) - Date.parse(run.startedAt),
    });
    await notifiers.events.publish({ type: 'run', id: run.id });
    if (run.taskId !== null) await notifiers.events.publish({ type: 'task', id: run.taskId });
    await notifiers.events.publish({ type: 'overview' });
    if (run.status !== 'limit_reached') return;
    // LIM-03: the owner learns why the work stopped instead of finding a silent thread.
    await transact(this.deps, async (tx, outbox) => {
      const body: BodyOf<'system'> = {
        text: `Run stopped at its limit: ${run.error ?? 'limit reached'}.`,
      };
      await messages.post(tx, outbox, {
        threadId: run.threadId,
        taskId: run.taskId,
        kind: 'system',
        body,
      });
    });
  }
}
