import type { Clock } from '../../application/ports/clock.js';
import type { IsoTime } from '../../domain/index.js';

export class SystemClock implements Clock {
  now(): IsoTime {
    return new Date().toISOString();
  }
}

/** Start of the local calendar day containing `now` (daily budget window, LIM-01), as ISO time. */
export function startOfLocalDay(now: IsoTime): IsoTime {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
