export interface Worktree {
  readonly branch: string;
  readonly path: string;
}

export interface WorktreeManager {
  /** Idempotent: a second call for the same task returns the existing worktree. Never deletes anything. */
  create(taskId: string): Promise<Worktree>;
}
