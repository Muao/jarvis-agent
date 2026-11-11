import type { UsageDto } from '@jarvis/shared';
import { canStartRun, type IsoTime, type Limits } from '../../domain/index.js';
import { startOfLocalDay } from '../runs/local-day.js';

/** The next local midnight after `now`: when "usage today" starts over. */
export function nextLocalMidnight(now: IsoTime): IsoTime {
  const next = new Date(startOfLocalDay(now));
  next.setDate(next.getDate() + 1);
  return next.toISOString();
}

/** Usage today against the daily budget (LIM-04). */
export function usageOf(
  spentTokens: number,
  limits: Pick<Limits, 'dailyBudgetTokens'>,
  now: IsoTime,
): UsageDto {
  return {
    todayTokens: spentTokens,
    budgetTokens: limits.dailyBudgetTokens,
    resetsAt: nextLocalMidnight(now),
    paused: !canStartRun(spentTokens, limits).ok,
  };
}
