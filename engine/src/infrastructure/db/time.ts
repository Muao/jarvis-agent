import type { IsoTime } from '../../domain/index.js';

/** The domain carries ISO strings; the database stores `timestamptz`. */
export const toDate = (time: IsoTime): Date => new Date(time);
export const toDateOrNull = (time: IsoTime | null): Date | null =>
  time === null ? null : new Date(time);
export const toIso = (date: Date): IsoTime => date.toISOString();
export const toIsoOrNull = (date: Date | null): IsoTime | null =>
  date === null ? null : date.toISOString();
