import type { TaskDetailDto } from '@jarvis/shared';
import { NotFoundError } from '../errors.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { RunCoordinator } from '../ports/run-coordinator.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { describeJournalEvent } from './journal-text.js';
import { pullRequestOf } from './pull-request.js';
import { toRunDto } from './run-dto.js';
import { stageAt, stageSpans } from './stage-spans.js';
import { toTaskDto } from './task-dto.js';
import { TaskWaiting } from './waiting.js';

/** `GET /api/tasks/:id`: everything Task detail shows. */
export class GetTask {
  private readonly waiting: TaskWaiting;

  constructor(
    private readonly deps: {
      readonly uow: UnitOfWork;
      readonly runs: RunCoordinator;
      readonly config: ConfigProvider;
      readonly artifacts: ArtifactStore;
    },
  ) {
    this.waiting = new TaskWaiting(deps.runs);
  }

  async execute(id: string): Promise<TaskDetailDto> {
    const { limits } = this.deps.config.current();
    const found = await this.deps.uow.run(async (tx) => {
      const task = await tx.tasks.get(id);
      if (task === null) throw new NotFoundError('task', id);
      const watch = task.pr === null ? null : await tx.watches.get(id);
      return {
        task,
        watch,
        waitingFor: await this.waiting.of(tx, task, watch),
        totals: (await tx.runs.totalsByTask()).get(id),
        runs: await tx.runs.listByTask(id),
        journal: await tx.journal.entries(id),
      };
    });
    const { task, watch, journal } = found;
    const stages = stageSpans(task, journal);
    return {
      ...toTaskDto(task, found),
      startedAt: task.startedAt,
      reason: task.reason,
      counters: {
        checks: { used: task.counters.checkRetries, max: limits.checkRetries },
        ciFixes: { used: task.counters.ciFixRounds, max: limits.ciFixRounds },
        reviews: { used: task.counters.reviewRounds, max: limits.reviewRounds },
      },
      stages,
      pullRequest: pullRequestOf(task, watch),
      runs: found.runs.map((run) =>
        toRunDto(run, { stage: stageAt(stages, run.startedAt), maxTurns: limits.maxTurnsPerRun }),
      ),
      journal: journal.map((entry) => ({
        id: String(entry.seq),
        at: entry.at,
        type: entry.type,
        text: describeJournalEvent(entry).text,
        by: entry.actor,
      })),
      artifacts: [...(await this.deps.artifacts.list(id))],
      workerSessionId: task.workerSessionId,
    };
  }
}
