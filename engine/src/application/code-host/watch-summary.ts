import type { CheckStatus, ReviewState } from '@jarvis/shared';
import type {
  CheckRun,
  PullRequestDiff,
  PullRequestSnapshot,
  WatchContext,
} from '../../domain/index.js';
import type { WatchedCheck, WatchedComment, WatchSummary } from '../ports/watch-repository.js';

const KEPT_COMMENTS = 50;
const KEPT_EARLIER_CHECKS = 30;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function statusOf(check: CheckRun): CheckStatus {
  if (check.status === 'queued') return 'queued';
  if (check.status === 'in_progress') return 'running';
  if (check.conclusion === 'success' || check.conclusion === 'neutral') return 'passed';
  return check.conclusion === 'skipped' ? 'skipped' : 'failed';
}

/** A re-run adds a check run with the same name and a higher id; only the newest counts (as in the diff). */
function latestChecks(checks: readonly CheckRun[]): WatchedCheck[] {
  const byName = new Map<string, CheckRun>();
  for (const check of checks) {
    const known = byName.get(check.name);
    if (known === undefined || check.id > known.id) byName.set(check.name, check);
  }
  return [...byName.values()]
    .sort((a, b) => a.id - b.id)
    .map((check) => ({ name: check.name, status: statusOf(check), url: check.url ?? null }));
}

/** The newest non-pending review of each allowlisted reviewer decides; one objection outweighs approvals. */
function verdict(
  snapshot: PullRequestSnapshot,
  context: WatchContext,
): { review: ReviewState; approvedBy: string[] } {
  const latest = new Map<string, { id: number; reviewer: string; state: ReviewState }>();
  for (const review of snapshot.reviews) {
    const allowed =
      !same(review.reviewer, context.botLogin) &&
      context.reviewers.some((r) => same(r, review.reviewer));
    if (!allowed || review.state === 'pending') continue;
    const key = review.reviewer.toLowerCase();
    const known = latest.get(key);
    if (known === undefined || review.id > known.id) latest.set(key, review);
  }
  const decided = [...latest.values()];
  const approvedBy = decided.filter((r) => r.state === 'approved').map((r) => r.reviewer);
  if (decided.some((r) => r.state === 'changes_requested')) {
    return { review: 'changes_requested', approvedBy };
  }
  return { review: approvedBy.length > 0 ? 'approved' : 'pending', approvedBy };
}

function newComments(
  snapshot: PullRequestSnapshot,
  diff: PullRequestDiff,
): readonly WatchedComment[] {
  const bodyOf = new Map(snapshot.comments.map((c) => [c.id, c.body]));
  const handled = diff.changes.flatMap((change) =>
    change.type === 'comment'
      ? [
          {
            id: change.commentId,
            author: change.author,
            body: change.body,
            handling: 'handled' as const,
            ignoredBecause: null,
          },
        ]
      : [],
  );
  const ignored = diff.ignored.map((c) => ({
    id: c.commentId,
    author: c.author,
    body: bodyOf.get(c.commentId) ?? '',
    handling: 'ignored' as const,
    ignoredBecause: c.reason,
  }));
  return [...handled, ...ignored];
}

export interface SummaryInput {
  readonly previous: WatchSummary | null;
  readonly snapshot: PullRequestSnapshot;
  readonly diff: PullRequestDiff;
  readonly context: WatchContext;
}

/**
 * The PR block of the Task detail, derived from one snapshot and what the diff found in it.
 * `approvedBy` is not stored; the final summary names the approvers.
 */
export function buildSummary(input: SummaryInput): {
  summary: WatchSummary;
  approvedBy: readonly string[];
} {
  const { previous, snapshot, diff, context } = input;
  const checks = latestChecks(snapshot.checks);
  const headChanged = previous !== null && previous.headSha !== snapshot.headSha;
  const earlierChecks = headChanged
    ? [...previous.checks, ...previous.earlierChecks]
    : (previous?.earlierChecks ?? []);
  const { review, approvedBy } = verdict(snapshot, context);
  return {
    approvedBy,
    summary: {
      headSha: snapshot.headSha,
      checks,
      earlierChecks: earlierChecks.slice(0, KEPT_EARLIER_CHECKS),
      ciGreen:
        checks.length > 0 && checks.every((c) => c.status === 'passed' || c.status === 'skipped'),
      review,
      comments: [...(previous?.comments ?? []), ...newComments(snapshot, diff)].slice(
        -KEPT_COMMENTS,
      ),
    },
  };
}
