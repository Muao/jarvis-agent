import type { JarvisConfig } from '@jarvis/shared';
import { elapsedMs, MS_PER_MINUTE, type IsoTime } from './time.js';

export type Limits = JarvisConfig['limits'];

/** Remaining daily budget in USD, never negative. */
export function usageLeft(spentTodayUsd: number, limits: Pick<Limits, 'dailyBudgetUsd'>): number {
  return Math.max(0, limits.dailyBudgetUsd - spentTodayUsd);
}

export type StartDecision =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'daily_budget_reached' };

/** LIM-04: once the day's estimated cost reaches the budget no new run starts. */
export function canStartRun(
  spentTodayUsd: number,
  limits: Pick<Limits, 'dailyBudgetUsd'>,
): StartDecision {
  return usageLeft(spentTodayUsd, limits) > 0
    ? { ok: true }
    : { ok: false, reason: 'daily_budget_reached' };
}

/** WRK-11: active worker time (sum of worker run durations since the last owner retry) at or over the limit. */
export function isTaskTimedOut(
  activeMs: number,
  limits: Pick<Limits, 'taskTimeoutMinutes'>,
): boolean {
  return activeMs >= limits.taskTimeoutMinutes * MS_PER_MINUTE;
}

/** DSP-09: a run that produced no event for `stallMinutes` is stalled. */
export function isStalled(
  lastEventAt: IsoTime,
  now: IsoTime,
  limits: Pick<Limits, 'stallMinutes'>,
): boolean {
  return elapsedMs(lastEventAt, now) >= limits.stallMinutes * MS_PER_MINUTE;
}
