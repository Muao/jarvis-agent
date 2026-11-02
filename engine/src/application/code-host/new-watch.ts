import type { Watch } from '../ports/watch-repository.js';

/** A watch for a PR nobody polled yet. */
export function newWatch(taskId: string, prNumber: number): Watch {
  return {
    taskId,
    prNumber,
    state: null,
    lastCheckedAt: null,
    summary: null,
    lastGreen: null,
    rerunHeadSha: null,
  };
}
