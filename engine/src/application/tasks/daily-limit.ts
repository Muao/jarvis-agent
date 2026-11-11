import type { Task, TaskEvent } from '../../domain/index.js';
import { startOfLocalDay } from '../runs/local-day.js';
import { transact } from '../transaction.js';
import type { TaskDeps } from './deps.js';

/** Journal row: a write to the code host was held back because the day's allowance is used up. */
export const DAILY_LIMIT_REACHED = 'daily_limit_reached';

export type DailyLimitKind = 'pr_comments' | 'commits';

const NAMES: Readonly<Record<DailyLimitKind, { what: string; key: string }>> = {
  pr_comments: { what: 'pull-request comments', key: 'limits.maxPrCommentsPerDay' },
  commits: { what: 'pushed commits', key: 'limits.maxCommitsPerDay' },
};

/**
 * The agent writes to the code host without asking; what keeps a runaway loop finite is a count per
 * local day, across every task. This returns the journal rows of `types` written since midnight —
 * the caller decides how much each one weighs.
 */
export function writesToday(
  deps: TaskDeps,
  types: readonly string[],
): Promise<readonly TaskEvent[]> {
  return transact(deps, (tx) => tx.journal.ofTypesSince(types, startOfLocalDay(deps.clock.now())));
}

/**
 * Records that `task` hit the day's limit and tells its thread — once per task, kind and day, so a
 * worker that tries again does not flood the chat. Returns the line to hand back to the agent.
 */
export async function reportDailyLimit(
  deps: TaskDeps,
  task: Task,
  kind: DailyLimitKind,
  limit: number,
): Promise<string> {
  const { what, key } = NAMES[kind];
  const text = `The daily limit of ${limit} ${what} is reached, so ${task.id} could not write to GitHub. It starts over at midnight; raise ${key} in the config to continue today.`;
  await transact(deps, async (tx, outbox) => {
    const today = await tx.journal.ofTypesSince(
      [DAILY_LIMIT_REACHED],
      startOfLocalDay(deps.clock.now()),
    );
    const told = today.some((event) => event.taskId === task.id && event.data['kind'] === kind);
    await deps.writer.note(tx, task.id, DAILY_LIMIT_REACHED, 'system', { kind, limit });
    if (told) return;
    await deps.messages.post(tx, outbox, {
      threadId: task.threadId,
      taskId: task.id,
      kind: 'system',
      body: { text },
    });
  });
  return text;
}
