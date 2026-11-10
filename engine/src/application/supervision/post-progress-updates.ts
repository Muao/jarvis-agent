import { elapsedMs, isStalled, MS_PER_MINUTE, type Run } from '../../domain/index.js';
import type { BodyOf } from '../conversation/message-bodies.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import { describeActivity, describeProgress, latestProgress } from '../queries/run-activity.js';
import type { TaskDeps } from '../tasks/deps.js';
import { transact } from '../transaction.js';

const MS_PER_SECOND = 1000;

const who = (run: Run): string =>
  run.taskId === null ? 'The dispatcher' : `The worker of ${run.taskId}`;

/**
 * The positive counterpart of `DetectStalls`: while a run is alive and producing events, the owner
 * gets a first line after `limits.firstProgressUpdateSeconds`, then one every
 * `limits.progressUpdateMinutes`, saying what it last wrote and which tool it is on. The engine derives
 * this from the event stream it already has, so a silent chat means a dead run — not a forgetful agent.
 * A run that is stalled or waiting for a permission answer is left to `DetectStalls`.
 */
export class PostProgressUpdates {
  /** Run id -> when it was last reported on. */
  private readonly lastPostedAt = new Map<string, string>();

  constructor(private readonly deps: TaskDeps & { readonly config: ConfigProvider }) {}

  async execute(): Promise<void> {
    const { uow, clock, config } = this.deps;
    const { limits } = config.current();
    const now = clock.now();
    const { runs, pending } = await uow.run(async (tx) => ({
      runs: await Promise.all(
        (await tx.runs.listRunning()).map(async (run) => ({
          run,
          last: await tx.runs.lastEvent(run.id),
          progress: await latestProgress(tx.runs, run.id),
          task: run.taskId === null ? null : await tx.tasks.get(run.taskId),
        })),
      ),
      pending: await tx.permissions.listPending(),
    }));
    const live = new Set(runs.map(({ run }) => run.id));
    for (const id of this.lastPostedAt.keys()) if (!live.has(id)) this.lastPostedAt.delete(id);

    const waiting = new Set(pending.map((request) => request.runId));
    for (const { run, last, task, progress } of runs) {
      if (waiting.has(run.id)) continue;
      const lastAt = last?.at ?? run.startedAt;
      if (isStalled(lastAt, now, limits)) continue;
      const previous = this.lastPostedAt.get(run.id);
      const due =
        previous === undefined
          ? limits.firstProgressUpdateSeconds * MS_PER_SECOND
          : limits.progressUpdateMinutes * MS_PER_MINUTE;
      if (elapsedMs(previous ?? run.startedAt, now) < due) continue;
      this.lastPostedAt.set(run.id, now);
      const inMs = elapsedMs(run.startedAt, now);
      const inText =
        inMs < MS_PER_MINUTE
          ? `${Math.floor(inMs / MS_PER_SECOND)} s`
          : `${Math.floor(inMs / MS_PER_MINUTE)} min`;
      const stage = task === null ? '' : `${task.stage}, `;
      const what = describeProgress(progress) ?? `Now: ${describeActivity(last)}`;
      await this.post(run, `${who(run)} is working — ${stage}${inText} in. ${what}.`);
    }
  }

  private async post(run: Run, text: string): Promise<void> {
    const body: BodyOf<'system'> = { text };
    await transact(this.deps, async (tx, outbox) => {
      await this.deps.messages.post(tx, outbox, {
        threadId: run.threadId,
        taskId: run.taskId,
        kind: 'system',
        body,
      });
    });
  }
}
