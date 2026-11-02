/** Time enters the domain as an ISO 8601 string passed by the caller; the domain never reads a clock. */
export type IsoTime = string;

export const MS_PER_MINUTE = 60_000;

export function toMs(time: IsoTime): number {
  return Date.parse(time);
}

/** Milliseconds from `earlier` to `later`. */
export function elapsedMs(earlier: IsoTime, later: IsoTime): number {
  return toMs(later) - toMs(earlier);
}

export function addMinutes(time: IsoTime, minutes: number): IsoTime {
  return new Date(toMs(time) + minutes * MS_PER_MINUTE).toISOString();
}
