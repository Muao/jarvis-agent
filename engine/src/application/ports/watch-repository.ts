import type { IsoTime, WatchState } from '../../domain/index.js';
import type { CheckStatus, ReviewState } from '@jarvis/shared';

export interface WatchedCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly url: string | null;
}

export interface WatchedComment {
  readonly id: string;
  readonly author: string;
  readonly body: string;
  readonly handling: 'pending' | 'handled' | 'ignored';
  /** Why an ignored comment was ignored (CI-06); null otherwise. */
  readonly ignoredBecause: 'bot' | 'not_allowlisted' | null;
}

/** What the Task detail's PR block shows; rewritten by every poll that sees a change (CI-02: none otherwise). */
export interface WatchSummary {
  readonly headSha: string;
  readonly checks: readonly WatchedCheck[];
  /** Checks of earlier commits, collapsed in the UI (CI-07). */
  readonly earlierChecks: readonly WatchedCheck[];
  /** Every check of the head completed and none failed. */
  readonly ciGreen: boolean;
  /** The verdict of the allowlisted reviewers. */
  readonly review: ReviewState;
  readonly comments: readonly WatchedComment[];
}

/** The last head whose checks all passed; a later red on the same head may be flaky. */
export interface GreenRun {
  readonly headSha: string;
  readonly checkNames: readonly string[];
}

/** The watcher's record for one open PR (CI-09): what it has already processed. */
export interface Watch {
  readonly taskId: string;
  readonly prNumber: number;
  /** Null until the first poll. */
  readonly state: WatchState | null;
  readonly lastCheckedAt: IsoTime | null;
  readonly summary: WatchSummary | null;
  readonly lastGreen: GreenRun | null;
  /** The head whose failed checks were re-run already; a head is re-run once. */
  readonly rerunHeadSha: string | null;
}

export interface WatchRepository {
  get(taskId: string): Promise<Watch | null>;
  /** Insert or update. */
  save(watch: Watch): Promise<void>;
  /** Watches of tasks that are not finished, oldest task first. */
  listActive(): Promise<readonly Watch[]>;
}
