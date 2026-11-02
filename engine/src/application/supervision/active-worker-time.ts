import {
  elapsedMs,
  STAGE_CHANGED,
  toMs,
  type IsoTime,
  type Run,
  type TaskEvent,
} from '../../domain/index.js';

/** When the owner last retried the task (a fresh time budget starts there), or null. */
function lastRetryAt(journal: readonly TaskEvent[]): IsoTime | null {
  const retries = journal.filter((e) => e.type === STAGE_CHANGED && e.data.cause === 'owner_retry');
  return retries.at(-1)?.at ?? null;
}

/**
 * WRK-11: active worker time is the sum of the durations of the task's worker runs since the last
 * owner retry; a run that is still going counts up to `now`. Waiting for a slot or the owner is not
 * counted because no run exists then.
 */
export function activeWorkerMs(
  runs: readonly Run[],
  journal: readonly TaskEvent[],
  now: IsoTime,
): number {
  const since = lastRetryAt(journal);
  return runs
    .filter((r) => r.role === 'worker' && (since === null || toMs(r.startedAt) >= toMs(since)))
    .reduce((sum, r) => sum + elapsedMs(r.startedAt, r.finishedAt ?? now), 0);
}
