import type { IsoTime } from '../../domain/index.js';

/** Local midnight of the day `now` falls in: the start of "usage today" (plan, Data). */
export function startOfLocalDay(now: IsoTime): IsoTime {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.toISOString();
}
