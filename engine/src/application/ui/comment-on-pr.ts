import type { EventActor, Task, TaskEvent } from '../../domain/index.js';
import type { CodeHost } from '../ports/code-host.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { AwaitPermission } from '../permissions/await-permission.js';
import type { RequestPermission } from '../permissions/request-permission.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from '../tasks/deps.js';
import { releaseDaily, reportDailyLimit, reserveDaily, writesToday } from '../tasks/daily-limit.js';
import { loadWorkerTask } from '../tasks/guards.js';
import { transact } from '../transaction.js';
import { isTrustedHead } from './trust-pull-request-head.js';

export const POSTED = 'ui_comment_posted';
export const EDITED = 'ui_comment_edited';
export const REFUSED = 'ui_comment_refused';
export const FAILED = 'ui_comment_failed';

/** How much of the comment the permission card shows, so the card stays readable. */
const PREVIEW = 600;

export type CommentOnPrResult =
  { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string };

/**
 * The comments this task wrote on the pull request, by id. Rows written before comment ids were
 * stored carry only the url, so the id is read back out of it — otherwise the first comment a task
 * ever posted would be the one comment it could never correct.
 */
function ownCommentIds(journal: readonly TaskEvent[]): ReadonlySet<number> {
  const ids = new Set<number>();
  for (const entry of journal) {
    if (entry.type !== POSTED && entry.type !== EDITED) continue;
    const stored = entry.data['commentId'];
    if (typeof stored === 'number') {
      ids.add(stored);
      continue;
    }
    const url = entry.data['url'];
    const id = typeof url === 'string' ? /#issuecomment-(\d+)$/.exec(url)?.[1] : undefined;
    if (id !== undefined) ids.add(Number(id));
  }
  return ids;
}

export interface CommentOnPrDeps extends TaskDeps {
  readonly codeHost: CodeHost;
  readonly config: ConfigProvider;
  readonly permissions: {
    readonly request: RequestPermission;
    readonly await: AwaitPermission;
  };
  /** Masks secrets in the comment before it leaves the machine (SEC-04). Absent: the text is posted as is. */
  readonly redact?: (text: string) => string;
}

/**
 * ADR-0018: the only way a run can write on a pull request. `gh pr comment` and `gh pr review` are
 * denied to the worker, so this is the single door.
 *
 * By default the write needs no owner approval (`ui.autoApproveComments`): the agent works on its
 * own, the journal records every write, and `limits.maxPrCommentsPerDay` bounds how many there can
 * be in a day across all tasks — at the limit the thread is told and nothing is posted. With the
 * setting off, every write asks the owner first — and so it does when the head of the pull request
 * is not trusted (a fork, or an author outside `allowlist.githubReviewers`: the same test as the
 * dev-server gate of ADR-0018), because what a stranger wrote is in the worker's context. The body
 * goes through the secret redactor either way. With `commentId` the body replaces an earlier comment
 * instead of adding one, which is how a corrected verdict reaches the reader without leaving the
 * stale one above it. Only a comment this task posted can be replaced — the id is checked against
 * the task's own journal, so an approved card can never be turned into an edit of somebody else's
 * words.
 */
export class CommentOnPr {
  constructor(private readonly deps: CommentOnPrDeps) {}

  async execute(
    identity: RunIdentity,
    input: { readonly body: string; readonly commentId?: number },
  ): Promise<CommentOnPrResult> {
    const { task, own } = await transact(this.deps, async (tx) => {
      const found = await loadWorkerTask(tx, identity);
      const journal = await tx.journal.list(found.id);
      return { task: found, own: ownCommentIds(journal) };
    });

    if (task.pr === null) {
      return {
        ok: false,
        reason: `task ${task.id} has no pull request to comment on; put the report in post_update instead`,
      };
    }
    const { commentId } = input;
    if (commentId !== undefined && !own.has(commentId)) {
      return {
        ok: false,
        reason: `comment ${String(commentId)} was not posted by task ${task.id}; post a new comment instead of editing someone else's`,
      };
    }

    // Posting and replacing both write to the pull request, so both count.
    const limit = this.deps.config.current().limits.maxPrCommentsPerDay;
    if ((await writesToday(this.deps, [POSTED, EDITED])).length >= limit) {
      const told = await reportDailyLimit(this.deps, task, 'pr_comments', limit);
      return { ok: false, reason: `${told} Keep the report in the thread and do not retry today.` };
    }

    const body = this.deps.redact?.(input.body) ?? input.body;
    const auto =
      this.deps.config.current().ui.autoApproveComments && (await this.headIsTrusted(task));
    if (!auto) {
      const permissionId = await this.deps.permissions.request.execute(identity, {
        tool_name: 'comment_on_pr',
        input: {
          pullRequest: task.pr.url,
          comment: body.length > PREVIEW ? `${body.slice(0, PREVIEW)}…` : body,
          characters: body.length,
          ...(commentId === undefined ? {} : { replaces: commentId }),
        },
      });
      const answer = await this.deps.permissions.await.execute(permissionId);

      if (answer.behavior !== 'allow') {
        await this.note(task.id, REFUSED, 'owner', {
          pr: task.pr.number,
          message: answer.message,
        });
        return {
          ok: false,
          reason: `the owner did not approve the comment (${answer.message}); the report stays in the thread`,
        };
      }
    }

    // The check above only spares the owner a card at the limit; this reservation is the real gate:
    // taken under a lock right before the write, so two tasks cannot both slip under the limit.
    const reserved = await reserveDaily(this.deps, {
      taskId: task.id,
      kind: 'pr_comments',
      amount: 1,
      limit,
      legacy: { types: [POSTED, EDITED], weight: () => 1 },
    });
    if (!reserved) {
      const told = await reportDailyLimit(this.deps, task, 'pr_comments', limit);
      return { ok: false, reason: `${told} Keep the report in the thread and do not retry today.` };
    }

    const repo = task.targetRepo ?? undefined;
    const result =
      commentId === undefined
        ? await this.deps.codeHost.postComment(task.pr.number, body, repo)
        : await this.deps.codeHost.editComment(commentId, body, repo);
    if (!result.ok)
      await releaseDaily(this.deps, { taskId: task.id, kind: 'pr_comments', amount: 1 });
    const kind = commentId === undefined ? POSTED : EDITED;
    await this.note(
      task.id,
      result.ok ? kind : FAILED,
      result.ok ? 'agent' : 'system',
      result.ok
        ? {
            pr: task.pr.number,
            url: result.url,
            commentId: result.id,
            reserved: true,
            ...(auto ? { asked: false } : {}),
          }
        : { pr: task.pr.number, reason: result.reason },
    );
    return result.ok ? { ok: true, url: result.url } : { ok: false, reason: result.reason };
  }

  /** A pull request that cannot be read is not trusted. */
  private async headIsTrusted(task: Task): Promise<boolean> {
    if (task.pr === null) return false;
    try {
      const pr = await this.deps.codeHost.describePullRequest(
        task.pr.number,
        task.targetRepo ?? undefined,
      );
      return isTrustedHead(pr, this.deps.config.current().allowlist.githubReviewers);
    } catch {
      return false;
    }
  }

  private async note(
    taskId: string,
    type: string,
    actor: EventActor,
    data: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await transact(this.deps, async (tx) => {
      await this.deps.writer.note(tx, taskId, type, actor, data);
    });
  }
}
