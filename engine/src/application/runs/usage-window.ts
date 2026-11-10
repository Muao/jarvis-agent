import type { IsoTime } from '../../domain/index.js';
import type { Repositories } from '../ports/unit-of-work.js';
import { startOfLocalDay } from './local-day.js';

/**
 * Where "usage today" starts: local midnight, or the owner's latest reset when that is later.
 * Every read of today's spend (scheduler, overview, config, reset) goes through here.
 */
export async function usageWindowStart(
  tx: Pick<Repositories, 'budgetResets'>,
  now: IsoTime,
): Promise<IsoTime> {
  const midnight = startOfLocalDay(now);
  const reset = await tx.budgetResets.latest();
  return reset !== null && reset > midnight ? reset : midnight;
}
