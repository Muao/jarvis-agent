import {
  recordCiFailure,
  recordReviewRound,
  type CodeHostChange,
  type PullRequestDiff,
  type Task,
} from '../../domain/index.js';
import type { BodyOf } from '../conversation/message-bodies.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { Repositories } from '../ports/unit-of-work.js';
import type { GreenRun, Watch, WatchSummary } from '../ports/watch-repository.js';
import type { TaskDeps } from '../tasks/deps.js';
import type { Outbox } from '../transaction.js';
import { ciFailureInput, names, reviewInput, shortSha } from './worker-input.js';

export interface CodeHostChangeInput {
  /** The task, in `PR Open`, with its PR. */
  readonly task: Task;
  readonly watch: Watch;
  readonly diff: PullRequestDiff;
  /** Derived from the same snapshot as `diff`. */
  readonly summary: WatchSummary;
  readonly approvedBy: readonly string[];
}

/** What the watcher must remember and do after the changes were handled. */
export interface CodeHostChangeResult {
  readonly lastGreen: GreenRun | null;
  readonly rerunHeadSha: string | null;
  /** Flaky CI: the host must run the failed checks again, after the transaction committed. */
  readonly rerun: { readonly prNumber: number; readonly headSha: string } | null;
}

type Fix = { readonly cause: 'ci_failed' | 'review_comment'; readonly text: string };

/**
 * CI-03…CI-05, CI-08: what a poll that found changes does to the task. Runs inside the watcher's
 * transaction, so the stored watch state and everything done about the changes commit together
 * (CI-09). All changes of one tick are one decision: one stage move, one input for the worker.
 */
export class HandleCodeHostChange {
  constructor(private readonly deps: TaskDeps & { readonly config: ConfigProvider }) {}

  async handle(
    tx: Repositories,
    outbox: Outbox,
    input: CodeHostChangeInput,
  ): Promise<CodeHostChangeResult> {
    const { diff, summary, watch } = input;
    const { limits } = this.deps.config.current();
    let task = input.task;
    let lastGreen = watch.lastGreen;
    let rerunHeadSha = watch.rerunHeadSha;
    let rerun: CodeHostChangeResult['rerun'] = null;
    const fixes: Fix[] = [];
    const blocks: string[] = [];
    const say = (text: string): Promise<unknown> => this.say(tx, outbox, task, text);
    const prNumber = watch.prNumber;

    await this.noteIgnored(tx, task, diff);

    const ci = diff.changes.find((c) => c.type === 'ci_completed');
    if (ci !== undefined) {
      const sha = shortSha(ci.headSha);
      await this.deps.writer.note(tx, task.id, 'ci_completed', 'system', {
        headSha: ci.headSha,
        conclusion: ci.conclusion,
      });
      if (ci.conclusion === 'success') {
        await say(`CI passed on ${sha} (${summary.checks.length} checks).`);
        lastGreen = { headSha: ci.headSha, checkNames: summary.checks.map((c) => c.name) };
      } else {
        const failed = summary.checks.filter((c) => c.status === 'failed');
        await say(`CI failed on ${sha}: ${names(failed)}.`);
        const flaky =
          lastGreen?.headSha === ci.headSha &&
          rerunHeadSha !== ci.headSha &&
          failed.every((c) => lastGreen?.checkNames.includes(c.name) === true);
        if (flaky) {
          rerunHeadSha = ci.headSha;
          rerun = { prNumber, headSha: ci.headSha };
          await this.deps.writer.note(tx, task.id, 'ci_rerun', 'system', { headSha: ci.headSha });
          await say('Possibly flaky — re-running once.');
        } else {
          const recorded = recordCiFailure(task, limits);
          if (recorded.outcome === 'fix') {
            task = await this.deps.writer.update(
              tx,
              outbox,
              recorded.task,
              'ci_fix_round',
              'system',
              {
                round: recorded.task.counters.ciFixRounds,
                max: limits.ciFixRounds,
                headSha: ci.headSha,
              },
            );
            fixes.push({
              cause: 'ci_failed',
              text: ciFailureInput({
                prNumber,
                prUrl: task.pr?.url ?? '',
                headSha: ci.headSha,
                failed,
                round: task.counters.ciFixRounds,
                maxRounds: limits.ciFixRounds,
              }),
            });
          } else {
            blocks.push(`CI is still red after ${limits.ciFixRounds} fix rounds`);
          }
        }
      }
    }

    const feedback = this.feedback(diff.changes);
    for (const review of diff.changes.filter((c) => c.type === 'review')) {
      if (review.state === 'approved') {
        await this.deps.writer.note(tx, task.id, 'review_approved', 'system', {
          reviewer: review.reviewer,
        });
      }
    }
    if (feedback.length > 0) {
      const recorded = recordReviewRound(task, limits);
      if (recorded.outcome === 'fix') {
        task = await this.deps.writer.update(tx, outbox, recorded.task, 'review_round', 'system', {
          round: recorded.task.counters.reviewRounds,
          max: limits.reviewRounds,
        });
        await say(
          `Review feedback received — fixing (round ${task.counters.reviewRounds}/${limits.reviewRounds}).`,
        );
        fixes.push({
          cause: 'review_comment',
          text: reviewInput({
            prNumber,
            entries: feedback,
            round: task.counters.reviewRounds,
            maxRounds: limits.reviewRounds,
          }),
        });
      } else {
        blocks.push(`Review feedback arrived after all ${limits.reviewRounds} review rounds`);
      }
    }

    if (blocks.length > 0) {
      await this.block(tx, outbox, task, blocks.join('; '));
    } else if (fixes.length > 0) {
      await this.fix(tx, outbox, task, fixes);
    } else if (this.readyToFinish(diff.changes, summary)) {
      await this.finish(tx, outbox, task, summary, input.approvedBy);
    }
    return { lastGreen, rerunHeadSha, rerun };
  }

  /** The tick's feedback, one line per allowlisted comment or change request (CI-05). */
  private feedback(changes: readonly CodeHostChange[]): string[] {
    return changes.flatMap((change) => {
      if (change.type === 'comment') return [`- ${change.author}: ${change.body.trim()}`];
      if (change.type === 'review' && change.state === 'changes_requested') {
        return [`- ${change.reviewer} requested changes.`];
      }
      return [];
    });
  }

  private readyToFinish(changes: readonly CodeHostChange[], summary: WatchSummary): boolean {
    const trigger = changes.some(
      (c) =>
        (c.type === 'ci_completed' && c.conclusion === 'success') ||
        (c.type === 'review' && c.state === 'approved'),
    );
    return trigger && summary.ciGreen && summary.review === 'approved';
  }

  /** CI-04, CI-05: rounds used up. The owner gets a question card, so an answer can unblock the task. */
  private async block(tx: Repositories, outbox: Outbox, task: Task, reason: string): Promise<void> {
    const blocked = await this.deps.writer.move(tx, outbox, task, 'Blocked', {
      cause: 'rounds_exhausted',
      reason,
    });
    const body: BodyOf<'question'> = {
      taskId: blocked.id,
      question: `${reason}. Tell me how to continue, or cancel the task.`,
      options: [],
    };
    await this.deps.messages.post(tx, outbox, {
      threadId: blocked.threadId,
      taskId: blocked.id,
      kind: 'question',
      body,
    });
  }

  private async fix(
    tx: Repositories,
    outbox: Outbox,
    task: Task,
    fixes: readonly Fix[],
  ): Promise<void> {
    const first = fixes[0];
    if (first === undefined) return;
    const fixing = await this.deps.writer.move(tx, outbox, task, 'Fixing', { cause: first.cause });
    const message = await this.deps.messages.postOwner(tx, outbox, {
      threadId: fixing.threadId,
      taskId: fixing.id,
      text: fixes.map((f) => f.text).join('\n\n'),
      source: first.cause === 'ci_failed' ? 'ci' : 'review',
    });
    await this.deps.writer.note(tx, fixing.id, 'worker_input', 'system', {
      messageId: message.id,
      source: fixes.map((f) => f.cause),
    });
    outbox.deliverToWorker(fixing.id);
    outbox.requestWorkerRun(fixing.id, 'resume');
  }

  /** CI-08: green and approved. Jarvis never merges. */
  private async finish(
    tx: Repositories,
    outbox: Outbox,
    task: Task,
    summary: WatchSummary,
    approvedBy: readonly string[],
  ): Promise<void> {
    const done = await this.deps.writer.move(tx, outbox, task, 'Done', {
      cause: 'ci_green_approved',
    });
    const left = summary.comments.filter(
      (c) => c.handling === 'ignored' && c.ignoredBecause === 'not_allowlisted',
    );
    const authors = [...new Set(left.map((c) => c.author))];
    const parts = [
      `PR #${done.pr?.number ?? '?'} is ready: CI is green on ${shortSha(summary.headSha)} and ${approvedBy.join(', ')} approved. Merging is up to you.`,
    ];
    if (left.length > 0) {
      parts.push(
        `${left.length} comment(s) from ${authors.join(', ')} were not acted on (not on the reviewer allowlist).`,
      );
    }
    const body: BodyOf<'result'> = {
      taskId: done.id,
      summary: parts.join(' '),
      prUrl: done.pr?.url ?? null,
    };
    await this.deps.messages.post(tx, outbox, {
      threadId: done.threadId,
      taskId: done.id,
      kind: 'result',
      body,
    });
  }

  /** CI-06: comments the agent does not act on stay out of the thread; humans' ones are journaled for the summary. */
  private async noteIgnored(tx: Repositories, task: Task, diff: PullRequestDiff): Promise<void> {
    for (const comment of diff.ignored) {
      if (comment.reason === 'bot') continue;
      await this.deps.writer.note(tx, task.id, 'comment_ignored', 'system', {
        commentId: comment.commentId,
        author: comment.author,
        reason: comment.reason,
      });
    }
  }

  private say(tx: Repositories, outbox: Outbox, task: Task, text: string): Promise<unknown> {
    const body: BodyOf<'system'> = { text };
    return this.deps.messages.post(tx, outbox, {
      threadId: task.threadId,
      taskId: task.id,
      kind: 'system',
      body,
    });
  }
}
