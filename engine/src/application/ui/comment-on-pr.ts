import type { EventActor } from '../../domain/index.js';
import type { CodeHost } from '../ports/code-host.js';
import type { AwaitPermission } from '../permissions/await-permission.js';
import type { RequestPermission } from '../permissions/request-permission.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from '../tasks/deps.js';
import { loadWorkerTask } from '../tasks/guards.js';
import { transact } from '../transaction.js';

export const POSTED = 'ui_comment_posted';
export const REFUSED = 'ui_comment_refused';
export const FAILED = 'ui_comment_failed';

/** How much of the comment the permission card shows, so the card stays readable. */
const PREVIEW = 600;

export type CommentOnPrResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: string };

export interface CommentOnPrDeps extends TaskDeps {
  readonly codeHost: CodeHost;
  readonly permissions: {
    readonly request: RequestPermission;
    readonly await: AwaitPermission;
  };
}

/**
 * ADR-0018: the only way a run can write on a pull request, and it never writes without the owner
 * saying so first. `gh pr comment` and `gh pr review` are denied to the worker, so this card is the
 * single door. One comment per task: a check that reports twice is a check nobody reads.
 */
export class CommentOnPr {
  constructor(private readonly deps: CommentOnPrDeps) {}

  async execute(
    identity: RunIdentity,
    input: { readonly body: string },
  ): Promise<CommentOnPrResult> {
    const { task, posted } = await transact(this.deps, async (tx) => {
      const found = await loadWorkerTask(tx, identity);
      const journal = await tx.journal.list(found.id);
      return { task: found, posted: journal.filter((e) => e.type === POSTED).length };
    });

    if (task.pr === null) {
      return {
        ok: false,
        reason: `task ${task.id} has no pull request to comment on; put the report in post_update instead`,
      };
    }
    if (posted > 0) {
      return {
        ok: false,
        reason: `a comment was already posted on ${task.pr.url} for this task; say the rest in the thread`,
      };
    }

    const permissionId = await this.deps.permissions.request.execute(identity, {
      tool_name: 'comment_on_pr',
      input: {
        pullRequest: task.pr.url,
        comment: input.body.length > PREVIEW ? `${input.body.slice(0, PREVIEW)}…` : input.body,
        characters: input.body.length,
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

    const result = await this.deps.codeHost.postComment(
      task.pr.number,
      input.body,
      task.targetRepo ?? undefined,
    );
    await this.note(
      task.id,
      result.ok ? POSTED : FAILED,
      result.ok ? 'agent' : 'system',
      result.ok
        ? { pr: task.pr.number, url: result.url }
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
