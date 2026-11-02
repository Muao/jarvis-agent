import type { PullRequestSnapshot } from '../../domain/index.js';

/** The pull-request host (GitHub in ADR-0009). The watcher polls it; nothing here calls a model. */
export interface CodeHost {
  /** The current state of one PR: checks of its head commit, reviews and comments. */
  snapshot(prNumber: number): Promise<PullRequestSnapshot>;
  /** The login Jarvis posts as; its own comments never trigger work (CI-06). */
  botLogin(): Promise<string>;
  /** Ask the host to run the failed checks of `headSha` again (flaky CI, CI-04). */
  rerunFailedChecks(prNumber: number, headSha: string): Promise<void>;
}
