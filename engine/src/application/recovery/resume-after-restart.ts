import type { TaskStage } from '@jarvis/shared';
import { interruptRun } from '../../domain/index.js';
import type { BodyOf } from '../conversation/message-bodies.js';
import type { LiveRuns } from '../runs/live-runs.js';
import type { ExpireOrphanedPermissions } from '../supervision/expire-orphaned-permissions.js';
import type { TaskDeps } from '../tasks/deps.js';
import { transact } from '../transaction.js';

/** Stages in which a worker should be running. The others wait for the owner, the PR or nothing. */
const WORKER_STAGES: readonly TaskStage[] = [
  'Intake',
  'Context',
  'Implementing',
  'Verifying',
  'Reviewing',
  'Fixing',
];

const RESTARTED = 'worker_restarted';

/**
 * ST-04, ST-05, NFR-04: run once when the engine starts. Runs the database still calls `running`
 * lost their process, so they become `interrupted`; permission requests nobody can answer are
 * denied; every task that was being worked on gets a worker again (its stored session is resumed);
 * threads with unprocessed owner messages get their dispatcher turn.
 *
 * Calling it again changes nothing and says nothing twice: only runs without a live process are
 * touched, and the "restarted" line is posted once per interruption.
 */
export class ResumeAfterRestart {
  constructor(
    private readonly deps: TaskDeps & {
      readonly liveRuns: LiveRuns;
      readonly orphanedPermissions: ExpireOrphanedPermissions;
    },
  ) {}

  async execute(): Promise<void> {
    await this.interruptLostRuns();
    await this.deps.orphanedPermissions.execute();
    await this.resumeWork();
  }

  private async interruptLostRuns(): Promise<void> {
    const { uow, clock, writer, liveRuns, notifiers } = this.deps;
    const interrupted = await uow.run(async (tx) => {
      const lost = (await tx.runs.listRunning()).filter((r) => liveRuns.get(r.id) === undefined);
      for (const run of lost) {
        await tx.runs.save(interruptRun(run, clock.now()));
        if (run.taskId !== null) {
          await writer.note(tx, run.taskId, 'run_interrupted', 'system', { runId: run.id });
        }
      }
      return lost;
    });
    for (const run of interrupted) {
      await notifiers.events.publish({ type: 'run', id: run.id });
      if (run.taskId !== null) await notifiers.events.publish({ type: 'task', id: run.taskId });
    }
    if (interrupted.length > 0) await notifiers.events.publish({ type: 'overview' });
  }

  private resumeWork(): Promise<void> {
    return transact(this.deps, async (tx, outbox) => {
      for (const task of await tx.tasks.listActive()) {
        if (!WORKER_STAGES.includes(task.stage)) continue;
        const journal = await tx.journal.list(task.id);
        if (journal.at(-1)?.type !== RESTARTED) {
          await this.deps.writer.note(tx, task.id, RESTARTED, 'system', { stage: task.stage });
          const body: BodyOf<'system'> = { text: `Worker restarted from stage ${task.stage}` };
          await this.deps.messages.post(tx, outbox, {
            threadId: task.threadId,
            taskId: task.id,
            kind: 'system',
            body,
          });
        }
        outbox.requestWorkerRun(task.id, 'resume');
      }
      for (const threadId of await tx.messages.threadsWithQueuedDispatcherInput()) {
        if ((await tx.tasks.activeForThread(threadId)) === null) {
          outbox.requestDispatcherTurn(threadId);
        }
      }
    });
  }
}
