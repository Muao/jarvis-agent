import { canTransition, isTaskTimedOut, MS_PER_MINUTE, type Task } from '../../domain/index.js';
import type { BodyOf } from '../conversation/message-bodies.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { TaskDeps } from '../tasks/deps.js';
import { transact } from '../transaction.js';
import { activeWorkerMs } from './active-worker-time.js';

/**
 * WRK-11: a task whose workers have run for `limits.taskTimeoutMinutes` of active time is stopped
 * and failed, and the thread gets a report. Only tasks with a running worker are checked; the
 * owner's retry gives a fresh budget. Called by a timer (T13).
 */
export class EnforceTaskTimeouts {
  constructor(
    private readonly deps: TaskDeps & {
      readonly config: ConfigProvider;
      readonly artifacts: ArtifactStore;
    },
  ) {}

  async execute(): Promise<void> {
    const running = await this.deps.uow.run((tx) => tx.runs.listRunning());
    const taskIds = new Set(
      running.flatMap((run) => (run.role === 'worker' && run.taskId !== null ? [run.taskId] : [])),
    );
    for (const taskId of taskIds) {
      try {
        await this.enforce(taskId);
      } catch (error) {
        this.deps.notifiers.logger.error('task timeout check failed', {
          taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private enforce(taskId: string): Promise<void> {
    return transact(this.deps, async (tx, outbox) => {
      const task = await tx.tasks.get(taskId);
      if (task === null || !canTransition(task, 'Failed')) return;
      const { limits } = this.deps.config.current();
      const activeMs = activeWorkerMs(
        await tx.runs.listByTask(taskId),
        await tx.journal.list(taskId),
        this.deps.clock.now(),
      );
      if (!isTaskTimedOut(activeMs, limits)) return;

      const minutes = Math.floor(activeMs / MS_PER_MINUTE);
      const error = `Time limit reached: ${minutes} of ${limits.taskTimeoutMinutes} active worker minutes used`;
      const done = await this.doneSoFar(task);
      const failed = await this.deps.writer.move(tx, outbox, task, 'Failed', {
        cause: 'task_timeout',
        reason: error,
      });
      const body: BodyOf<'system'> = {
        text: [
          `Task ${failed.id} failed. ${error}.`,
          `Done so far: ${done}.`,
          'Open question: retry with a fresh time budget, or cancel the task?',
        ].join('\n'),
      };
      await this.deps.messages.post(tx, outbox, {
        threadId: failed.threadId,
        taskId: failed.id,
        kind: 'system',
        body,
      });
      outbox.stopTaskRuns(failed.id);
    });
  }

  /** The report's "what was done": the stage reached, the artifacts written and the PR, if any. */
  private async doneSoFar(task: Task): Promise<string> {
    const written = (await this.deps.artifacts.list(task.id))
      .filter((file) => file.exists)
      .map((file) => file.name);
    const parts = [`reached stage ${task.stage}`];
    if (written.length > 0) parts.push(`wrote ${written.join(', ')}`);
    if (task.pr !== null) parts.push(`opened PR #${task.pr.number}`);
    return parts.join('; ');
  }
}
