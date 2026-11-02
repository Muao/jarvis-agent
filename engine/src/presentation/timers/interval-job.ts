// A small primitive for the engine's background loops (CI-02, DSP-09, WRK-11, LIM-04).
import type { Logger } from '../../application/ports/logger.js';

/** Timer functions, injectable so tests never wait. */
export interface TimerApi {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemTimers: TimerApi = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    // A pending tick alone must not keep the process alive.
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface IntervalJobOptions {
  /** Used in log lines. */
  readonly name: string;
  readonly run: () => Promise<void>;
  /** Milliseconds between ticks; a function is re-read before each tick so config edits apply (LIM-05). */
  readonly intervalMs: number | (() => number);
  readonly logger: Logger;
  readonly timers?: TimerApi;
  /** Run one tick right away on start (catch-up after sleep, CI-09). Default false. */
  readonly immediate?: boolean;
}

/**
 * Runs `run` on an interval. Ticks never overlap: a tick that finds the previous run still going is skipped.
 * A failing run is logged and the next tick still happens.
 */
export class IntervalJob {
  private readonly timers: TimerApi;
  private handle: unknown;
  private started = false;
  private inFlight: Promise<void> | null = null;
  private rerun = false;

  constructor(private readonly options: IntervalJobOptions) {
    this.timers = options.timers ?? systemTimers;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.options.immediate === true) this.tick();
    this.schedule();
  }

  /** Runs now; when a run is in flight, runs once more right after it (for example after a config change). */
  trigger(): void {
    if (!this.started) return;
    if (this.inFlight) this.rerun = true;
    else this.tick();
  }

  /** Stops ticking and waits for the run in flight. */
  async stop(): Promise<void> {
    this.started = false;
    this.rerun = false;
    if (this.handle !== undefined) this.timers.clearTimeout(this.handle);
    this.handle = undefined;
    await this.inFlight;
  }

  private schedule(): void {
    if (!this.started) return;
    const { intervalMs } = this.options;
    const ms = typeof intervalMs === 'function' ? intervalMs() : intervalMs;
    this.handle = this.timers.setTimeout(() => {
      this.handle = undefined;
      this.schedule();
      if (!this.inFlight) this.tick();
    }, ms);
  }

  private tick(): void {
    const { name, run, logger } = this.options;
    const current = (async () => {
      try {
        await run();
      } catch (error) {
        logger.error(`${name} failed`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })().then(() => {
      this.inFlight = null;
      if (this.rerun && this.started) {
        this.rerun = false;
        this.tick();
      }
    });
    this.inFlight = current;
  }
}
