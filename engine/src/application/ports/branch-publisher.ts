import type { RepoTarget } from './code-host.js';

export interface BranchStatus {
  /** `git status --porcelain` paths, ignored files excepted. */
  readonly dirtyFiles: readonly string[];
  /** Commits on the worktree's HEAD beyond the base branch. */
  readonly commitsAhead: number;
  /** Files changed between the base and HEAD. */
  readonly changedFiles: readonly string[];
}

export type PushResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'rejected' | 'unreachable'; readonly detail: string };

/**
 * ADR-0022: the engine's own git, run in a task's worktree. The worker never pushes; this does,
 * with the token, an explicit refspec and none of the repository's own config.
 */
export interface BranchPublisher {
  /** HEAD of the task's worktree. */
  headSha(taskId: string): Promise<string>;
  status(taskId: string): Promise<BranchStatus>;
  /**
   * Pushes exactly `sha` to `refs/heads/jarvis/<taskId>` of `repo`, fast-forward only. Never
   * throws for a refusal or a network error; the `detail` is redacted.
   */
  push(input: {
    readonly taskId: string;
    readonly repo: RepoTarget;
    readonly sha: string;
  }): Promise<PushResult>;
  /**
   * The file's content at the tip of the remote base branch, fetched now (not the worktree's
   * possibly stale copy). `null` when the file does not exist or the fetch fails; never throws.
   */
  baseFile(input: {
    readonly taskId: string;
    readonly repo: RepoTarget;
    readonly path: string;
  }): Promise<string | null>;
  /** `git merge-base HEAD <base>` in the worktree: read-only, no network. */
  mergeBase(taskId: string): Promise<string>;
  /**
   * Detaches the worktree at `sha`, runs `run`, and checks `jarvis/<taskId>` out again, even when
   * `run` throws. Throws if the tree is dirty before the switch.
   */
  onBase<T>(taskId: string, sha: string, run: () => Promise<T>): Promise<T>;
}
