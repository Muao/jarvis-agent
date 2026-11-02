// Test helper: manual timers, so tests advance time by calling `fire()` instead of waiting.
import type { TimerApi } from '../interval-job.js';

interface Scheduled {
  readonly callback: () => void;
  readonly ms: number;
}

export class FakeTimers implements TimerApi {
  /** Every delay ever requested, in order. */
  readonly delays: number[] = [];
  private scheduled: Scheduled[] = [];

  setTimeout(callback: () => void, ms: number): unknown {
    this.delays.push(ms);
    const entry = { callback, ms };
    this.scheduled.push(entry);
    return entry;
  }

  clearTimeout(handle: unknown): void {
    this.scheduled = this.scheduled.filter((entry) => entry !== handle);
  }

  get pending(): boolean {
    return this.scheduled.length > 0;
  }

  /** Fires the scheduled tick with that delay (the first one when `ms` is omitted), as if the delay had passed. */
  fire(ms?: number): void {
    const entry = this.scheduled.find((e) => ms === undefined || e.ms === ms);
    if (entry === undefined)
      throw new Error(`no timer scheduled${ms === undefined ? '' : ` for ${ms} ms`}`);
    this.scheduled = this.scheduled.filter((e) => e !== entry);
    entry.callback();
  }
}
