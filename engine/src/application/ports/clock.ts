import type { IsoTime } from '../../domain/index.js';

export interface Clock {
  now(): IsoTime;
}
