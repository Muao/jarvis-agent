import type { TaskDto, WaitingFor } from '@jarvis/shared';
import type { Task } from '../../domain/index.js';
import type { RunTotals } from '../ports/run-repository.js';
import type { Watch } from '../ports/watch-repository.js';
import { ciStatusOf } from './pull-request.js';

const NO_RUNS: RunTotals = { runCount: 0, costUsd: 0 };

/** A row of the task list; Task detail extends it. */
export function toTaskDto(
  task: Task,
  facts: {
    waitingFor: WaitingFor;
    watch: Watch | null;
    totals: RunTotals | undefined;
    working: ReadonlySet<string>;
  },
): TaskDto {
  const totals = facts.totals ?? NO_RUNS;
  return {
    id: task.id,
    threadId: task.threadId,
    title: task.title,
    stage: task.stage,
    working: facts.working.has(task.id),
    waitingFor: facts.waitingFor,
    branch: task.branch,
    prNumber: task.pr?.number ?? null,
    prUrl: task.pr?.url ?? null,
    ci: ciStatusOf(facts.watch?.summary ?? null),
    runCount: totals.runCount,
    costUsd: totals.costUsd,
    updatedAt: task.updatedAt,
  };
}
