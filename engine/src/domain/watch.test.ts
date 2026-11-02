import { describe, expect, it } from 'vitest';
import {
  diffPullRequest,
  type CheckRun,
  type PullRequestComment,
  type PullRequestReview,
  type PullRequestSnapshot,
  type WatchContext,
} from './watch.js';

const ctx: WatchContext = { botLogin: 'jarvis-bot', reviewers: ['alice', 'Bob'] };

const check = (
  id: number,
  name: string,
  conclusion: CheckRun['conclusion'],
  status?: CheckRun['status'],
): CheckRun => ({
  id,
  name,
  status: status ?? (conclusion === null ? 'in_progress' : 'completed'),
  conclusion,
});
const review = (
  id: number,
  reviewer: string,
  state: PullRequestReview['state'],
): PullRequestReview => ({
  id,
  reviewer,
  state,
});
const comment = (
  id: number,
  author: string,
  extra: Partial<PullRequestComment> = {},
): PullRequestComment => ({
  id: `issue:${id}`,
  author,
  isBot: false,
  body: `c${id}`,
  ...extra,
});
const snap = (extra: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  headSha: 'aaa',
  checks: [],
  reviews: [],
  comments: [],
  ...extra,
});

describe('diffPullRequest: CI', () => {
  it('a fresh PR with no checks yields nothing', () => {
    const { changes, ignored, next } = diffPullRequest(null, snap(), ctx);
    expect(changes).toEqual([]);
    expect(ignored).toEqual([]);
    expect(next).toEqual({ headSha: 'aaa', checks: [], reviews: [], seenCommentIds: [] });
  });

  it('waits while any check is still running', () => {
    const s = snap({ checks: [check(1, 'build', 'success'), check(2, 'test', null)] });
    expect(diffPullRequest(null, s, ctx).changes).toEqual([]);
  });

  it('a queued check blocks completion too', () => {
    const s = snap({ checks: [check(1, 'build', 'success'), check(2, 'test', null, 'queued')] });
    expect(diffPullRequest(null, s, ctx).changes).toEqual([]);
  });

  it('emits success once everything is completed and green', () => {
    const s = snap({
      checks: [
        check(1, 'build', 'success'),
        check(2, 'lint', 'skipped'),
        check(3, 'e2e', 'neutral'),
      ],
    });
    expect(diffPullRequest(null, s, ctx).changes).toEqual([
      { type: 'ci_completed', headSha: 'aaa', conclusion: 'success' },
    ]);
  });

  it('emits failure only after the remaining checks finish', () => {
    const running = snap({ checks: [check(1, 'build', 'failure'), check(2, 'test', null)] });
    const first = diffPullRequest(null, running, ctx);
    expect(first.changes).toEqual([]);
    const done = snap({ checks: [check(1, 'build', 'failure'), check(2, 'test', 'success')] });
    expect(diffPullRequest(first.next, done, ctx).changes).toEqual([
      { type: 'ci_completed', headSha: 'aaa', conclusion: 'failure' },
    ]);
  });

  it.each(['cancelled', 'timed_out', 'action_required', 'stale'] as const)(
    'treats %s as a failure',
    (conclusion) => {
      const s = snap({ checks: [check(1, 'build', conclusion)] });
      expect(diffPullRequest(null, s, ctx).changes).toEqual([
        { type: 'ci_completed', headSha: 'aaa', conclusion: 'failure' },
      ]);
    },
  );

  it('is idempotent: the same snapshot twice yields no second change (CI-09)', () => {
    const s = snap({
      checks: [check(1, 'build', 'success')],
      reviews: [review(10, 'alice', 'approved')],
      comments: [comment(100, 'alice'), comment(101, 'jarvis-bot')],
    });
    const first = diffPullRequest(null, s, ctx);
    expect(first.changes).toHaveLength(3);
    const second = diffPullRequest(first.next, s, ctx);
    expect(second.changes).toEqual([]);
    expect(second.ignored).toEqual([]);
    expect(second.next).toEqual(first.next);
  });

  it('a new head SHA starts over and ignores the old results (CI-07)', () => {
    const old = diffPullRequest(null, snap({ checks: [check(1, 'build', 'failure')] }), ctx);
    expect(old.changes).toHaveLength(1);

    const pushed = snap({ headSha: 'bbb', checks: [check(2, 'build', null)] });
    const mid = diffPullRequest(old.next, pushed, ctx);
    expect(mid.changes).toEqual([]);
    expect(mid.next.headSha).toBe('bbb');

    const green = snap({ headSha: 'bbb', checks: [check(2, 'build', 'success')] });
    expect(diffPullRequest(mid.next, green, ctx).changes).toEqual([
      { type: 'ci_completed', headSha: 'bbb', conclusion: 'success' },
    ]);
  });

  it('a new head whose checks are not yet reported does not re-emit the old result', () => {
    const old = diffPullRequest(null, snap({ checks: [check(1, 'build', 'success')] }), ctx);
    const pushed = snap({ headSha: 'bbb', checks: [] });
    expect(diffPullRequest(old.next, pushed, ctx).changes).toEqual([]);
  });

  it('after a missed poll, the final result of the new head is reported once (laptop slept)', () => {
    const old = diffPullRequest(null, snap({ checks: [check(1, 'build', 'failure')] }), ctx);
    const later = snap({ headSha: 'ccc', checks: [check(5, 'build', 'success')] });
    const woke = diffPullRequest(old.next, later, ctx);
    expect(woke.changes).toEqual([{ type: 'ci_completed', headSha: 'ccc', conclusion: 'success' }]);
    expect(diffPullRequest(woke.next, later, ctx).changes).toEqual([]);
  });

  it('a re-run of the same check on the same head is reported again, and only the newest run counts', () => {
    const failed = snap({ checks: [check(1, 'build', 'failure')] });
    const first = diffPullRequest(null, failed, ctx);
    const rerun = snap({ checks: [check(1, 'build', 'failure'), check(2, 'build', 'success')] });
    const second = diffPullRequest(first.next, rerun, ctx);
    expect(second.changes).toEqual([
      { type: 'ci_completed', headSha: 'aaa', conclusion: 'success' },
    ]);
    expect(diffPullRequest(second.next, rerun, ctx).changes).toEqual([]);
  });

  it('an in-progress re-run hides the older failure until it finishes', () => {
    const rerun = snap({ checks: [check(1, 'build', 'failure'), check(2, 'build', null)] });
    expect(diffPullRequest(null, rerun, ctx).changes).toEqual([]);
  });
});

describe('diffPullRequest: reviews', () => {
  it.each(['approved', 'changes_requested'] as const)(
    'reports an allowlisted reviewer %s',
    (state) => {
      const { changes } = diffPullRequest(
        null,
        snap({ reviews: [review(10, 'alice', state)] }),
        ctx,
      );
      expect(changes).toEqual([{ type: 'review', reviewId: 10, reviewer: 'alice', state }]);
    },
  );

  it('matches reviewers case-insensitively', () => {
    const { changes } = diffPullRequest(
      null,
      snap({ reviews: [review(10, 'bob', 'approved')] }),
      ctx,
    );
    expect(changes).toHaveLength(1);
  });

  it('ignores reviews from people off the allowlist and from the bot', () => {
    const s = snap({
      reviews: [review(10, 'mallory', 'approved'), review(11, 'jarvis-bot', 'approved')],
    });
    expect(diffPullRequest(null, s, ctx).changes).toEqual([]);
  });

  it('ignores pending (draft) reviews, then reports them when submitted', () => {
    const draft = diffPullRequest(null, snap({ reviews: [review(10, 'alice', 'pending')] }), ctx);
    expect(draft.changes).toEqual([]);
    const submitted = diffPullRequest(
      draft.next,
      snap({ reviews: [review(10, 'alice', 'changes_requested')] }),
      ctx,
    );
    expect(submitted.changes).toEqual([
      { type: 'review', reviewId: 10, reviewer: 'alice', state: 'changes_requested' },
    ]);
  });

  it('reports a review that moves from changes_requested to approved', () => {
    const first = diffPullRequest(
      null,
      snap({ reviews: [review(10, 'alice', 'changes_requested')] }),
      ctx,
    );
    const second = diffPullRequest(
      first.next,
      snap({ reviews: [review(10, 'alice', 'approved')] }),
      ctx,
    );
    expect(second.changes).toEqual([
      { type: 'review', reviewId: 10, reviewer: 'alice', state: 'approved' },
    ]);
  });

  it('keeps seen reviews across a new head (reviews are not reset by pushes)', () => {
    const first = diffPullRequest(null, snap({ reviews: [review(10, 'alice', 'approved')] }), ctx);
    const pushed = snap({ headSha: 'bbb', reviews: [review(10, 'alice', 'approved')] });
    expect(diffPullRequest(first.next, pushed, ctx).changes).toEqual([]);
  });
});

describe('diffPullRequest: comments', () => {
  it('reports comments from allowlisted humans, in snapshot order', () => {
    const { changes, next } = diffPullRequest(
      null,
      snap({ comments: [comment(7, 'Bob'), comment(5, 'alice')] }),
      ctx,
    );
    expect(changes).toEqual([
      { type: 'comment', commentId: 'issue:7', author: 'Bob', body: 'c7' },
      { type: 'comment', commentId: 'issue:5', author: 'alice', body: 'c5' },
    ]);
    expect(next.seenCommentIds).toEqual(['issue:7', 'issue:5']);
  });

  it('ignores our own account, other bots and people off the allowlist, and says why (CI-06)', () => {
    const s = snap({
      comments: [
        comment(1, 'jarvis-bot'),
        comment(2, 'dependabot', { isBot: true }),
        comment(3, 'mallory'),
        comment(4, 'alice'),
      ],
    });
    const { changes, ignored } = diffPullRequest(null, s, ctx);
    expect(changes).toEqual([
      { type: 'comment', commentId: 'issue:4', author: 'alice', body: 'c4' },
    ]);
    expect(ignored).toEqual([
      { commentId: 'issue:1', author: 'jarvis-bot', reason: 'bot' },
      { commentId: 'issue:2', author: 'dependabot', reason: 'bot' },
      { commentId: 'issue:3', author: 'mallory', reason: 'not_allowlisted' },
    ]);
  });

  it('an allowlisted login flagged as a bot is still ignored', () => {
    const { changes, ignored } = diffPullRequest(
      null,
      snap({ comments: [comment(1, 'alice', { isBot: true })] }),
      ctx,
    );
    expect(changes).toEqual([]);
    expect(ignored).toHaveLength(1);
  });

  it('reports only comments not seen before', () => {
    const first = diffPullRequest(null, snap({ comments: [comment(1, 'alice')] }), ctx);
    const second = diffPullRequest(
      first.next,
      snap({ comments: [comment(1, 'alice'), comment(2, 'alice')] }),
      ctx,
    );
    expect(second.changes).toEqual([
      { type: 'comment', commentId: 'issue:2', author: 'alice', body: 'c2' },
    ]);
    expect(second.next.seenCommentIds).toEqual(['issue:1', 'issue:2']);
  });

  it('does not report an ignored comment again on the next poll', () => {
    const s = snap({ comments: [comment(1, 'mallory')] });
    const first = diffPullRequest(null, s, ctx);
    expect(first.ignored).toHaveLength(1);
    expect(diffPullRequest(first.next, s, ctx).ignored).toEqual([]);
  });

  it('keeps seen ids when a comment disappears from the list', () => {
    const first = diffPullRequest(null, snap({ comments: [comment(9, 'alice')] }), ctx);
    const second = diffPullRequest(first.next, snap(), ctx);
    expect(second.next.seenCommentIds).toEqual(['issue:9']);
  });

  it('reports a review comment whose number is lower than an already seen issue comment', () => {
    const first = diffPullRequest(null, snap({ comments: [comment(900, 'alice')] }), ctx);
    const review = { ...comment(5, 'alice'), id: 'review:5' };
    const s = snap({ comments: [comment(900, 'alice'), review] });
    const second = diffPullRequest(first.next, s, ctx);
    expect(second.changes).toEqual([
      { type: 'comment', commentId: 'review:5', author: 'alice', body: 'c5' },
    ]);
    expect(diffPullRequest(second.next, s, ctx).changes).toEqual([]);
  });

  it('issue:5 and review:5 are different comments', () => {
    const s = snap({ comments: [comment(5, 'alice'), { ...comment(5, 'alice'), id: 'review:5' }] });
    expect(diffPullRequest(null, s, ctx).changes).toHaveLength(2);
  });
});
