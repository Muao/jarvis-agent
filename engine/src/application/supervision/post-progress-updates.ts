import { elapsedMs, isStalled, MS_PER_MINUTE, type Run } from '../../domain/index.js';
import type { BodyOf } from '../conversation/message-bodies.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import { describeActivity } from '../queries/run-activity.js';
import type { TaskDeps } from '../tasks/deps.js';
import { transact } from '../transaction.js';

const who = (run: Run): string =>
  run.taskId === null ? 'The dispatcher' : `The worker of ${run.taskId}`;

/**
 * The positive counterpart of `DetectStalls`: while a run is alive and producing events, the owner
 * gets a line every `limits.progressUpdateMinutes` saying what it is doing. The engine derives this
 * from the event stream it already has, so a silent chat means a dead run — not a forgetful agent.
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
          task: run.taskId === null ? null : await tx.tasks.get(run.taskId),
        })),
      ),
      pending: await tx.permissions.listPending(),
    }));
    const live = new Set(runs.map(({ run }) => run.id));
    for (const id of this.lastPostedAt.keys()) if (!live.has(id)) this.lastPostedAt.delete(id);

    const waiting = new Set(pending.map((request) => request.runId));
    for (const { run, last, task } of runs) {
      if (waiting.has(run.id)) continue;
      const lastAt = last?.at ?? run.startedAt;
      if (isStalled(lastAt, now, limits)) continue;
      const since = this.lastPostedAt.get(run.id) ?? run.startedAt;
      if (elapsedMs(since, now) < limits.progressUpdateMinutes * MS_PER_MINUTE) continue;
      this.lastPostedAt.set(run.id, now);
      const minutes = Math.floor(elapsedMs(run.startedAt, now) / MS_PER_MINUTE);
      const stage = task === null ? '' : `${task.stage}, `;
      await this.post(
        run,
        `${who(run)} is working — ${stage}${minutes} min in. Now: ${describeActivity(last)}.`,
      );
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
