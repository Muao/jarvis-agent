import type { ReviewState } from '@jarvis/shared';

export type CheckRunStatus = 'queued' | 'in_progress' | 'completed';

export type CheckConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'stale';

export interface CheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: CheckRunStatus;
  readonly conclusion: CheckConclusion | null;
  /** Where the owner (and the worker) can read the check's log, when the host gives one. */
  readonly url?: string;
}

export interface PullRequestReview {
  readonly id: number;
  readonly reviewer: string;
  readonly state: ReviewState;
}

export interface PullRequestComment {
  /**
   * Namespaced by source, `issue:<n>` or `review:<n>`: GitHub numbers issue comments and PR review
   * comments in separate sequences, so a bare number (or a "highest seen") is not comparable.
   */
  readonly id: string;
  readonly author: string;
  readonly isBot: boolean;
  readonly body: string;
}

/** What the code host reports about one PR at one moment. */
export interface PullRequestSnapshot {
  readonly headSha: string;
  /** Check runs of `headSha` only; older commits are the adapter's concern, not ours (CI-07). */
  readonly checks: readonly CheckRun[];
  readonly reviews: readonly PullRequestReview[];
  readonly comments: readonly PullRequestComment[];
}

/** What the watcher already processed; persisted in `watches` (CI-09). */
export interface WatchState {
  readonly headSha: string;
  readonly checks: readonly {
    readonly id: number;
    readonly status: CheckRunStatus;
    readonly conclusion: CheckConclusion | null;
  }[];
  readonly reviews: readonly { readonly id: number; readonly state: ReviewState }[];
  /**
   * Every comment id already processed, ignored ones included. Not pruned: GitHub lists a PR's comments
   * in full on every poll and a PR has few, so the list stays small.
   */
  readonly seenCommentIds: readonly string[];
}

export type CodeHostChange =
  | {
      readonly type: 'ci_completed';
      readonly headSha: string;
      readonly conclusion: 'success' | 'failure';
    }
  | {
      readonly type: 'review';
      readonly reviewId: number;
      readonly reviewer: string;
      readonly state: ReviewState;
    }
  | {
      readonly type: 'comment';
      readonly commentId: string;
      readonly author: string;
      readonly body: string;
    };

export interface IgnoredComment {
  readonly commentId: string;
  readonly author: string;
  readonly reason: 'bot' | 'not_allowlisted';
}

export interface WatchContext {
  /** The login Jarvis posts as; its own comments never trigger work (CI-06). */
  readonly botLogin: string;
  /** `allowlist.githubReviewers` */
  readonly reviewers: readonly string[];
}

export interface PullRequestDiff {
  readonly changes: readonly CodeHostChange[];
  readonly ignored: readonly IgnoredComment[];
  readonly next: WatchState;
}

const PASSING: readonly (CheckConclusion | null)[] = ['success', 'neutral', 'skipped'];

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A re-run adds a check run with the same name and a higher id; only the newest counts. */
function latestByName(checks: readonly CheckRun[]): CheckRun[] {
  const byName = new Map<string, CheckRun>();
  for (const check of checks) {
    const known = byName.get(check.name);
    if (known === undefined || check.id > known.id) byName.set(check.name, check);
  }
  return [...byName.values()].sort((a, b) => a.id - b.id);
}

function allCompleted(checks: readonly { status: CheckRunStatus }[]): boolean {
  return checks.length > 0 && checks.every((c) => c.status === 'completed');
}

function sameChecks(
  a: WatchState['checks'],
  b: readonly { id: number; conclusion: CheckConclusion | null }[],
): boolean {
  return (
    a.length === b.length &&
    a.every((c, i) => c.id === b[i]?.id && c.conclusion === b[i].conclusion)
  );
}

/**
 * Pure and idempotent: feeding `next` back with the same snapshot yields no changes (CI-09, ADR-0007).
 * CI is judged on the current head only; a new head resets the check state (CI-07).
 */
export function diffPullRequest(
  prev: WatchState | null,
  snapshot: PullRequestSnapshot,
  context: WatchContext,
): PullRequestDiff {
  const changes: CodeHostChange[] = [];
  const ignored: IgnoredComment[] = [];

  const checks = latestByName(snapshot.checks);
  const prevChecks = prev !== null && prev.headSha === snapshot.headSha ? prev.checks : [];
  const alreadyReported = allCompleted(prevChecks) && sameChecks(prevChecks, checks);
  if (allCompleted(checks) && !alreadyReported) {
    changes.push({
      type: 'ci_completed',
      headSha: snapshot.headSha,
      conclusion: checks.every((c) => PASSING.includes(c.conclusion)) ? 'success' : 'failure',
    });
  }

  const seenReviews = new Map((prev?.reviews ?? []).map((r) => [r.id, r.state]));
  for (const review of snapshot.reviews) {
    const allowed =
      !same(review.reviewer, context.botLogin) &&
      context.reviewers.some((r) => same(r, review.reviewer));
    if (allowed && review.state !== 'pending' && seenReviews.get(review.id) !== review.state) {
      changes.push({
        type: 'review',
        reviewId: review.id,
        reviewer: review.reviewer,
        state: review.state,
      });
    }
  }

  const seen = new Set(prev?.seenCommentIds ?? []);
  const fresh = snapshot.comments.filter((c) => !seen.has(c.id));
  for (const comment of fresh) {
    if (comment.isBot || same(comment.author, context.botLogin)) {
      ignored.push({ commentId: comment.id, author: comment.author, reason: 'bot' });
    } else if (!context.reviewers.some((r) => same(r, comment.author))) {
      ignored.push({ commentId: comment.id, author: comment.author, reason: 'not_allowlisted' });
    } else {
      changes.push({
        type: 'comment',
        commentId: comment.id,
        author: comment.author,
        body: comment.body,
      });
    }
  }

  const next: WatchState = {
    headSha: snapshot.headSha,
    checks: checks.map((c) => ({ id: c.id, status: c.status, conclusion: c.conclusion })),
    reviews: snapshot.reviews.map((r) => ({ id: r.id, state: r.state })),
    seenCommentIds: [...seen, ...fresh.map((c) => c.id)],
  };
  return { changes, ignored, next };
}
