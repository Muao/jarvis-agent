import type { JarvisConfig, TaskStage } from '@jarvis/shared';
import { DomainError } from './errors.js';
import { taskEvent, type EventActor, type TaskEvent } from './task-event.js';
import type { IsoTime } from './time.js';

export interface PullRequestRef {
  readonly number: number;
  readonly url: string;
}

export interface TaskCounters {
  readonly checkRetries: number;
  readonly ciFixRounds: number;
  readonly reviewRounds: number;
}

export interface Task {
  readonly id: string;
  readonly threadId: string;
  readonly title: string;
  readonly stage: TaskStage;
  /** Set only while `Blocked`: the stage the task returns to when the owner answers. */
  readonly resumeStage: TaskStage | null;
  readonly branch: string;
  readonly pr: PullRequestRef | null;
  readonly counters: TaskCounters;
  readonly workerSessionId: string | null;
  readonly startedAt: IsoTime;
  readonly updatedAt: IsoTime;
  /** Why the task is `Blocked`, `Failed` or `Cancelled`; null otherwise. */
  readonly reason: string | null;
}

export const TERMINAL: readonly TaskStage[] = ['Done', 'Failed', 'Cancelled'];

export function isTerminal(stage: TaskStage): boolean {
  return TERMINAL.includes(stage);
}

export function isActive(task: Pick<Task, 'stage'>): boolean {
  return !isTerminal(task.stage);
}

const EXITS = ['Blocked', 'Failed', 'Cancelled'] as const satisfies readonly TaskStage[];

/**
 * Legal moves (plan "Task stages"). `Blocked` is special: it may only return to the stage stored in
 * `resumeStage` (or be cancelled), see `canTransition`. `Failed` stores the stage it failed in and returns there only on `owner_retry`. `Done` and `Cancelled` accept nothing.
 */
export const TRANSITIONS: Readonly<Record<TaskStage, readonly TaskStage[]>> = {
  Intake: ['Context', ...EXITS],
  Context: ['Spec Review', ...EXITS],
  'Spec Review': ['Context', 'Implementing', ...EXITS],
  Implementing: ['Verifying', 'Reviewing', ...EXITS],
  Verifying: ['Implementing', 'Reviewing', 'PR Open', ...EXITS],
  Reviewing: ['Implementing', 'Verifying', 'PR Open', ...EXITS],
  'PR Open': ['Fixing', 'Done', ...EXITS],
  Fixing: ['PR Open', ...EXITS],
  Blocked: ['Cancelled'],
  Done: [],
  Failed: [],
  Cancelled: [],
};

export type TransitionCause =
  | 'worker_started'
  | 'spec_submitted'
  | 'spec_changes_requested'
  | 'spec_approved'
  | 'stage_reported'
  | 'pr_reported'
  | 'ci_failed'
  | 'review_comment'
  | 'ci_green_approved'
  | 'owner_done'
  | 'ask_owner'
  | 'source_unavailable'
  | 'rounds_exhausted'
  | 'owner_answered'
  | 'owner_retry'
  | 'checks_exhausted'
  | 'task_timeout'
  | 'owner_cancelled';

/** Who triggers each cause; recorded as the journal actor. */
export const CAUSE_ACTOR: Readonly<Record<TransitionCause, EventActor>> = {
  worker_started: 'system',
  spec_submitted: 'agent',
  spec_changes_requested: 'owner',
  spec_approved: 'owner',
  stage_reported: 'agent',
  pr_reported: 'agent',
  ci_failed: 'system',
  review_comment: 'system',
  ci_green_approved: 'system',
  owner_done: 'owner',
  ask_owner: 'agent',
  source_unavailable: 'system',
  rounds_exhausted: 'system',
  owner_answered: 'owner',
  owner_retry: 'owner',
  checks_exhausted: 'system',
  task_timeout: 'system',
  owner_cancelled: 'owner',
};

export const STAGE_CHANGED = 'stage_changed';

export interface TransitionInput {
  readonly cause: TransitionCause;
  readonly at: IsoTime;
  readonly reason?: string;
}

export interface Transitioned {
  readonly task: Task;
  readonly event: TaskEvent;
}

export interface NewTask {
  readonly id: string;
  readonly threadId: string;
  readonly title: string;
  readonly branch: string;
  readonly at: IsoTime;
}

const ZERO_COUNTERS: TaskCounters = { checkRetries: 0, ciFixRounds: 0, reviewRounds: 0 };

export function createTask(input: NewTask): Task {
  return {
    id: input.id,
    threadId: input.threadId,
    title: input.title,
    stage: 'Intake',
    resumeStage: null,
    branch: input.branch,
    pr: null,
    counters: ZERO_COUNTERS,
    workerSessionId: null,
    startedAt: input.at,
    updatedAt: input.at,
    reason: null,
  };
}

export function canTransition(task: Pick<Task, 'stage' | 'resumeStage'>, to: TaskStage): boolean {
  if (task.stage === 'Blocked') return to === task.resumeStage || to === 'Cancelled';
  // Failed is final for automation; only the owner's retry (checked in `transition`) leaves it.
  if (task.stage === 'Failed') return to === task.resumeStage;
  return TRANSITIONS[task.stage].includes(to);
}

const REASON_STAGES: readonly TaskStage[] = ['Blocked', 'Failed', 'Cancelled'];

export function transition(task: Task, to: TaskStage, input: TransitionInput): Transitioned {
  if (!canTransition(task, to)) {
    throw new DomainError(
      'illegal_transition',
      `Task ${task.id}: ${task.stage} -> ${to} is not allowed`,
    );
  }
  if (task.stage === 'Failed' && input.cause !== 'owner_retry') {
    throw new DomainError('illegal_transition', `Task ${task.id}: only owner_retry leaves Failed`);
  }
  const freshAttempts =
    input.cause === 'owner_retry' || (task.stage === 'Blocked' && input.cause === 'owner_answered');
  const reason = REASON_STAGES.includes(to) ? (input.reason ?? null) : null;
  const next: Task = {
    ...task,
    stage: to,
    resumeStage: to === 'Blocked' || to === 'Failed' ? task.stage : null,
    // A fresh set of attempts after the owner answers a block or retries a failed stage.
    counters: freshAttempts ? ZERO_COUNTERS : task.counters,
    reason,
    updatedAt: input.at,
  };
  const event = taskEvent(task.id, STAGE_CHANGED, input.at, CAUSE_ACTOR[input.cause], {
    from: task.stage,
    to,
    cause: input.cause,
    reason,
  });
  return { task: next, event };
}

export function attachPullRequest(task: Task, pr: PullRequestRef, at: IsoTime): Task {
  return { ...task, pr, updatedAt: at };
}

export function assignWorkerSession(task: Task, sessionId: string, at: IsoTime): Task {
  return { ...task, workerSessionId: sessionId, updatedAt: at };
}

type Limits = JarvisConfig['limits'];

export interface CounterResult<Outcome extends string> {
  readonly task: Task;
  readonly outcome: Outcome;
}

function bump(
  task: Task,
  key: keyof TaskCounters,
  limit: number,
): { task: Task; granted: boolean } {
  if (task.counters[key] >= limit) return { task, granted: false };
  return {
    task: { ...task, counters: { ...task.counters, [key]: task.counters[key] + 1 } },
    granted: true,
  };
}

/** WRK-07: a red check is retried until `checkRetries` is used up, then the task fails. */
export function recordCheckFailure(
  task: Task,
  limits: Pick<Limits, 'checkRetries'>,
): CounterResult<'retry' | 'fail'> {
  const { task: next, granted } = bump(task, 'checkRetries', limits.checkRetries);
  return { task: next, outcome: granted ? 'retry' : 'fail' };
}

/** CI-04: a red CI gets `ciFixRounds` fix rounds, then the task blocks. */
export function recordCiFailure(
  task: Task,
  limits: Pick<Limits, 'ciFixRounds'>,
): CounterResult<'fix' | 'block'> {
  const { task: next, granted } = bump(task, 'ciFixRounds', limits.ciFixRounds);
  return { task: next, outcome: granted ? 'fix' : 'block' };
}

/** CI-05: allowed review comments get `reviewRounds` rounds, then the task blocks. */
export function recordReviewRound(
  task: Task,
  limits: Pick<Limits, 'reviewRounds'>,
): CounterResult<'fix' | 'block'> {
  const { task: next, granted } = bump(task, 'reviewRounds', limits.reviewRounds);
  return { task: next, outcome: granted ? 'fix' : 'block' };
}
