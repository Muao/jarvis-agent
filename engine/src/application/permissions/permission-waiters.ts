interface Waiter {
  readonly done: Promise<void>;
  readonly settle: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * In-memory wake-ups for long-polling permission requests: nothing polls the database. A waiter is
 * released when the request is decided, or when its timeout fires.
 */
export class PermissionWaiters {
  private readonly waiting = new Map<string, Waiter>();

  /** Resolves once `settle(id)` is called or `timeoutMs` passed, whichever is first. Several callers share one waiter. */
  wait(id: string, timeoutMs: number, onTimeout: () => Promise<void>): Promise<void> {
    const known = this.waiting.get(id);
    if (known !== undefined) return known.done;
    let settle: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => {
      void onTimeout().finally(() => this.settle(id));
    }, timeoutMs);
    this.waiting.set(id, { done, settle, timer });
    return done;
  }

  settle(id: string): void {
    const waiter = this.waiting.get(id);
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    this.waiting.delete(id);
    waiter.settle();
  }
}
