import type { ModelUsage, Role, RunStatus, StopReason, TokenUsage } from '@jarvis/shared';
import { DomainError } from './errors.js';
import type { IsoTime } from './time.js';

export interface Run {
  readonly id: string;
  readonly sessionId: string;
  readonly role: Role;
  readonly threadId: string;
  readonly taskId: string | null;
  readonly status: RunStatus;
  readonly startedAt: IsoTime;
  readonly finishedAt: IsoTime | null;
  readonly costUsd: number;
  readonly turns: number;
  readonly usage: TokenUsage;
  /**
   * Jarvis's own vocabulary for how the *run* ended, derived from the result `subtype` in
   * `outcomeEnding`; null while `running`. Not the CLI's `stop_reason` (the model's API stop reason,
   * e.g. `end_turn`) and not its `terminal_reason` (the CLI's run-level ending).
   */
  readonly stopReason: StopReason | null;
  readonly modelUsage: ModelUsage;
  readonly exitCode: number | null;
  readonly error: string | null;
}

export const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function startRun(input: {
  id: string;
  sessionId: string;
  role: Role;
  threadId: string;
  taskId: string | null;
  at: IsoTime;
}): Run {
  return {
    id: input.id,
    sessionId: input.sessionId,
    role: input.role,
    threadId: input.threadId,
    taskId: input.taskId,
    status: 'running',
    startedAt: input.at,
    finishedAt: null,
    costUsd: 0,
    turns: 0,
    usage: EMPTY_USAGE,
    stopReason: null,
    modelUsage: {},
    exitCode: null,
    error: null,
  };
}

interface Totals {
  readonly costUsd: number;
  readonly turns: number;
  readonly usage: TokenUsage;
  readonly modelUsage?: ModelUsage;
}

/** How a `claude` process ended, as seen by the engine. */
export type RunOutcome =
  /** The CLI's final `result` line. `subtype` is its `subtype` field. */
  | ({ readonly type: 'result'; readonly subtype: string; readonly message?: string } & Totals)
  /** The process exited without a `result` line. */
  | { readonly type: 'exit'; readonly code: number | null; readonly message?: string }
  /** The CLI reported an exhausted subscription limit. */
  | { readonly type: 'rate_limited'; readonly message?: string }
  /** The owner or the engine stopped it on purpose. */
  | { readonly type: 'stopped' };

interface Ending {
  readonly status: RunStatus;
  readonly stopReason: StopReason;
  readonly error: string | null;
}

/** The one place that decides how an outcome ends a run: its status, its stop reason and its error. */
function outcomeEnding(outcome: RunOutcome): Ending {
  switch (outcome.type) {
    case 'stopped':
      return { status: 'stopped', stopReason: 'cancelled', error: null };
    case 'rate_limited':
      return {
        status: 'limit_reached',
        stopReason: 'rate_limited',
        error: outcome.message ?? 'subscription limit reached',
      };
    case 'exit':
      return {
        status: 'failed',
        stopReason: 'killed',
        error:
          outcome.message ?? `claude exited (code ${outcome.code ?? 'unknown'}) without a result`,
      };
    case 'result':
      switch (outcome.subtype) {
        case 'success':
          return { status: 'completed', stopReason: 'success', error: null };
        case 'error_max_turns':
          return {
            status: 'limit_reached',
            stopReason: 'max_turns',
            error: outcome.message ?? 'max turns reached',
          };
        case 'error_max_budget_usd':
          return {
            status: 'limit_reached',
            stopReason: 'budget',
            error: outcome.message ?? 'max budget reached',
          };
        default:
          return {
            status: 'failed',
            stopReason: 'error',
            error: outcome.message ?? outcome.subtype,
          };
      }
  }
}

/** Maps the CLI result to a `RunStatus` (LIM-03). A finished run cannot finish again. */
export function finishRun(run: Run, outcome: RunOutcome, at: IsoTime): Run {
  if (run.status !== 'running') {
    throw new DomainError('run_not_running', `Run ${run.id} is already ${run.status}`);
  }
  const { status, stopReason, error } = outcomeEnding(outcome);
  const totals = outcome.type === 'result' ? outcome : run;
  return {
    ...run,
    status,
    stopReason,
    error,
    finishedAt: at,
    costUsd: totals.costUsd,
    turns: totals.turns,
    usage: totals.usage,
    modelUsage: outcome.type === 'result' ? (outcome.modelUsage ?? {}) : run.modelUsage,
    exitCode: outcome.type === 'exit' ? outcome.code : run.exitCode,
  };
}

/** ST-05: a run that was `running` when the engine stopped. */
export function interruptRun(run: Run, at: IsoTime): Run {
  if (run.status !== 'running') {
    throw new DomainError('run_not_running', `Run ${run.id} is already ${run.status}`);
  }
  return { ...run, status: 'interrupted', stopReason: 'killed', finishedAt: at };
}
