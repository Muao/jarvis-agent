import type { EventActor, TaskEvent } from '../../domain/index.js';
import type { CodeHost } from '../ports/code-host.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { AwaitPermission } from '../permissions/await-permission.js';
import type { RequestPermission } from '../permissions/request-permission.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from '../tasks/deps.js';
import { loadWorkerTask } from '../tasks/guards.js';
import { transact } from '../transaction.js';

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
}

/**
 * ADR-0018: the only way a run can write on a pull request. `gh pr comment` and `gh pr review` are
 * denied to the worker, so this is the single door.
 *
 * Every write asks the owner separately, so there is no count to keep: the owner decides each time
 * whether the pull request needs another comment. The one exception is `ui.autoApproveComments`,
 * which the owner sets themselves to stop being asked; it is off by default, and with it on the
 * journal still records every write, because the trail is the only thing left. With `commentId` the body replaces an earlier comment
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

    if (!this.deps.config.current().ui.autoApproveComments) {
      const permissionId = await this.deps.permissions.request.execute(identity, {
        tool_name: 'comment_on_pr',
        input: {
          pullRequest: task.pr.url,
          comment: input.body.length > PREVIEW ? `${input.body.slice(0, PREVIEW)}…` : input.body,
          characters: input.body.length,
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

    const repo = task.targetRepo ?? undefined;
    const result =
      commentId === undefined
        ? await this.deps.codeHost.postComment(task.pr.number, input.body, repo)
        : await this.deps.codeHost.editComment(commentId, input.body, repo);
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
            ...(this.deps.config.current().ui.autoApproveComments ? { asked: false } : {}),
          }
        : { pr: task.pr.number, reason: result.reason },
    );
    return result.ok ? { ok: true, url: result.url } : { ok: false, reason: result.reason };
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
