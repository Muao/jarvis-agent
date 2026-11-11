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

/** Journal rows of the reservation ledger: an amount set aside before the write, and given back. */
const RESERVED = 'daily_reserved';
const RELEASED = 'daily_released';

const amountOf = (event: TaskEvent): number =>
  typeof event.data['amount'] === 'number' ? event.data['amount'] : 0;

/**
 * Sets `amount` of the day's `kind` allowance aside, atomically across tasks: under a lock the
 * count of what is already reserved plus `amount` is compared with `limit` and, if it fits, the
 * reservation is journalled in the same transaction. Two concurrent tasks can no longer both pass the
 * check and then both write. A write that then fails must `releaseDaily`; a crash in between leaves
 * the amount counted, which errs on the side of the limit.
 *
 * `legacyTypes` are rows older code wrote straight after the write, with no reservation; they count
 * for the rest of the day they were written on, unless they carry `reserved: true`.
 */
export function reserveDaily(
  deps: TaskDeps,
  input: {
    readonly taskId: string;
    readonly kind: DailyLimitKind;
    readonly amount: number;
    readonly limit: number;
    readonly legacy?: {
      readonly types: readonly string[];
      readonly weight: (event: TaskEvent) => number;
    };
  },
): Promise<boolean> {
  const { taskId, kind, amount, limit, legacy } = input;
  return transact(deps, async (tx) => {
    await tx.journal.lock(`daily:${kind}`);
    const since = startOfLocalDay(deps.clock.now());
    const rows = await tx.journal.ofTypesSince(
      [RESERVED, RELEASED, ...(legacy === undefined ? [] : legacy.types)],
      since,
    );
    let used = 0;
    for (const event of rows) {
      if (event.type === RESERVED && event.data['kind'] === kind) used += amountOf(event);
      else if (event.type === RELEASED && event.data['kind'] === kind) used -= amountOf(event);
      else if (
        legacy !== undefined &&
        legacy.types.includes(event.type) &&
        event.data['reserved'] !== true
      ) {
        used += legacy.weight(event);
      }
    }
    if (used + amount > limit) return false;
    await deps.writer.note(tx, taskId, RESERVED, 'system', { kind, amount });
    return true;
  });
}

/** Gives a reservation back: the write it was for did not happen. */
export function releaseDaily(
  deps: TaskDeps,
  input: { readonly taskId: string; readonly kind: DailyLimitKind; readonly amount: number },
): Promise<void> {
  return transact(deps, (tx) =>
    deps.writer.note(tx, input.taskId, RELEASED, 'system', {
      kind: input.kind,
      amount: input.amount,
    }),
  );
}
