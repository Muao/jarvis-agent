import type { Task } from '../../domain/index.js';
import type { CodeHost, PullRequestDescription } from '../ports/code-host.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { AwaitPermission } from '../permissions/await-permission.js';
import type { RequestPermission } from '../permissions/request-permission.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from '../tasks/deps.js';
import { transact } from '../transaction.js';

export const HEAD_APPROVED = 'ui_head_approved';
export const HEAD_REFUSED = 'ui_head_refused';

export interface TrustDecision {
  readonly trusted: boolean;
  /** Why, in one line, for the journal and for the agent. */
  readonly detail: string;
}

export interface TrustHeadDeps extends TaskDeps {
  readonly config: ConfigProvider;
  readonly codeHost: CodeHost;
  readonly permissions: {
    readonly request: RequestPermission;
    readonly await: AwaitPermission;
  };
}

function reviewerListed(author: string, reviewers: readonly string[]): boolean {
  const login = author.toLowerCase();
  return reviewers.some((r) => r.toLowerCase() === login);
}

/**
 * ADR-0018: starting the dev server of a pull request runs that pull request's code — its build
 * config, its plugins, its lifecycle scripts. For a branch of our own repo written by someone the
 * owner already trusts to review, that is the same risk as any other run. For a fork, or an author
 * nobody vouched for, it is arbitrary code execution, so the owner decides, every task, with the
 * author and the command in front of them. There is deliberately no setting that skips the card.
 */
export class TrustPullRequestHead {
  constructor(private readonly deps: TrustHeadDeps) {}

  async decide(identity: RunIdentity, task: Task): Promise<TrustDecision> {
    if (task.kind !== 'ui_check' || task.pr === null) {
      return { trusted: true, detail: 'not a pull-request check' };
    }

    let pr: PullRequestDescription;
    try {
      pr = await this.deps.codeHost.describePullRequest(
        task.pr.number,
        task.targetRepo ?? undefined,
      );
    } catch (error) {
      return {
        trusted: false,
        detail: `cannot read pull request ${task.pr.number}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const reviewers = this.deps.config.current().allowlist.githubReviewers;
    if (!pr.fromFork && reviewerListed(pr.author, reviewers)) {
      return {
        trusted: true,
        detail: `head ${pr.headRef} is in ${pr.headRepo.owner}/${pr.headRepo.name} and ${pr.author} is an allow-listed reviewer`,
      };
    }

    // An approval already given for this task covers its retry: the head is the same head.
    if (await this.alreadyApproved(task.id)) {
      return { trusted: true, detail: 'the owner approved this head earlier in this task' };
    }

    const why = pr.fromFork
      ? `the head lives in the fork ${pr.headRepo.owner}/${pr.headRepo.name}`
      : `${pr.author === '' ? 'the author' : pr.author} is not in allowlist.githubReviewers`;
    const devCommand = this.deps.config.current().ui.devCommand;
    const permissionId = await this.deps.permissions.request.execute(identity, {
      tool_name: 'start_dev_server',
      input: {
        pullRequest: task.pr.url,
        author: pr.author,
        head: `${pr.headRepo.owner}/${pr.headRepo.name}:${pr.headRef}`,
        fromFork: pr.fromFork,
        willRun: devCommand,
        warning: `Running this pull request's code on this machine. ${why}.`,
      },
    });
    const answer = await this.deps.permissions.await.execute(permissionId);
    const approved = answer.behavior === 'allow';

    await transact(this.deps, async (tx) => {
      await this.deps.writer.note(
        tx,
        task.id,
        approved ? HEAD_APPROVED : HEAD_REFUSED,
        'owner',
        { pr: task.pr?.number ?? null, author: pr.author, fromFork: pr.fromFork, why },
      );
    });

    return approved
      ? { trusted: true, detail: `the owner approved running the code of ${pr.author}'s head` }
      : {
          trusted: false,
          detail: `untrusted head: owner did not approve (${why}); ${answer.behavior === 'deny' ? answer.message : 'no answer'}`,
        };
  }

  private async alreadyApproved(taskId: string): Promise<boolean> {
    return transact(this.deps, async (tx) => {
      const journal = await tx.journal.list(taskId);
      return journal.some((e) => e.type === HEAD_APPROVED);
    });
  }
}
