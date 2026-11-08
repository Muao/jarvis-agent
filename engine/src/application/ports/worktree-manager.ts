export interface Worktree {
  readonly branch: string;
  readonly path: string;
}

export interface WorktreeManager {
  /**
   * Idempotent: a second call for the same task returns the existing worktree. Never deletes anything.
   * `targetRepo` (ADR-0012) creates the worktree against that repo (cloned on demand) instead of the
   * configured default; null/absent keeps today's behaviour.
   */
  create(taskId: string, targetRepo?: { owner: string; name: string } | null): Promise<Worktree>;
  /**
   * ADR-0018: a worktree standing on an existing pull request's head, for a `ui_check` task. The
   * local branch is `jarvis-check/<taskId>` — a different prefix from `jarvis/*`, so no push rule
   * written for task branches can ever match a branch holding someone else's commits. Idempotent.
   */
  createForPullRequest(
    taskId: string,
    targetRepo: { owner: string; name: string } | null,
    prNumber: number,
  ): Promise<Worktree>;
}
