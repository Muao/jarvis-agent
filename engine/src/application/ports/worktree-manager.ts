export interface Worktree {
  readonly branch: string;
  readonly path: string;
}

export interface WorktreeManager {
  /**
   * Idempotent: a second call for the same task returns the existing worktree. Never deletes anything.
   * `targetRepo` (ADR-0019) creates the worktree against that repo (cloned on demand) instead of the
   * configured default; null/absent keeps today's behaviour.
   */
  create(taskId: string, targetRepo?: { owner: string; name: string } | null): Promise<Worktree>;
}
