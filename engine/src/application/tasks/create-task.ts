import type { TaskKind } from '@jarvis/shared';
import { createTask } from '../../domain/index.js';
import { transact } from '../transaction.js';
import { ForbiddenError, InvalidInputError, NotFoundError } from '../errors.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { RepoResolver } from '../ports/repo-resolver.js';
import type { WorktreeManager } from '../ports/worktree-manager.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from './deps.js';
import { requireDispatcher } from './guards.js';
import {
  parsePullRequestRef,
  pullRequestUrl,
  type RequestedPullRequest,
} from './pull-request-ref.js';

export interface CreateTaskInput {
  readonly title: string;
  readonly description: string;
  /** ADR-0012: the repo to create the task's worktree in, besides the configured default. */
  readonly repo?: string;
  /** ADR-0018: `ui_check` only looks at a pull request that already exists; `build` is the default. */
  readonly kind?: TaskKind;
  /** ADR-0018: the pull request a `ui_check` task is about; required for it, refused otherwise. */
  readonly pr?: string;
}

export interface CreatedTask {
  readonly taskId: string;
  readonly branch: string;
}

/** DSP-01: the dispatcher turns a code request into a task with a worktree, a branch and a status card. */
export class CreateTask {
  constructor(
    private readonly deps: TaskDeps & {
      readonly ids: IdGenerator;
      readonly worktrees: WorktreeManager;
      readonly repos: RepoResolver;
    },
  ) {}

  async execute(identity: RunIdentity, input: CreateTaskInput): Promise<CreatedTask> {
    requireDispatcher(identity);
    const kind: TaskKind = input.kind ?? 'build';
    const requested = this.requestedPullRequest(kind, input);
    const repoName = requested?.repo ?? input.repo;
    const targetRepo = repoName === undefined ? null : await this.resolve(repoName);
    return transact(this.deps, async (tx, outbox) => {
      const thread = await tx.threads.get(identity.threadId);
      if (thread === null) throw new NotFoundError('thread', identity.threadId);
      if ((await tx.tasks.activeForThread(thread.id)) !== null) {
        throw new ForbiddenError(`thread ${thread.id} already has an active task`);
      }
      // The thread's title is the first owner message, truncated; once a task gives the thread a
      // real name, rename it so it is findable in the thread list instead of staying generic forever.
      if (thread.title !== input.title) {
        await tx.threads.save({ ...thread, title: input.title, updatedAt: this.deps.clock.now() });
      }

      const id = await tx.tasks.nextId();
      const pr =
        requested === null
          ? null
          : {
              number: requested.number,
              url: requested.url ?? pullRequestUrl(targetRepo!, requested.number),
            };
      const worktree =
        pr === null
          ? await this.deps.worktrees.create(id, targetRepo)
          : await this.checkoutPullRequest(id, targetRepo, pr.number);
      const task = createTask({
        id,
        threadId: thread.id,
        title: input.title,
        branch: worktree.branch,
        at: this.deps.clock.now(),
        targetRepo,
        kind,
        pr,
      });
      await this.deps.writer.update(tx, outbox, task, 'task_created', 'agent', {
        title: input.title,
        description: input.description,
        branch: worktree.branch,
        kind,
        ...(pr === null ? {} : { pr: pr.number, prUrl: pr.url }),
      });
      outbox.requestWorkerRun(id, 'start');
      return { taskId: id, branch: worktree.branch };
    });
  }

  /**
   * ADR-0018: `pr` belongs to a `ui_check` task and only to one. A bare number is refused unless
   * `repo` names the repository, because a number alone would resolve to whatever PR the default
   * repo happens to have under it.
   */
  private requestedPullRequest(
    kind: TaskKind,
    input: CreateTaskInput,
  ): RequestedPullRequest | null {
    if (kind === 'build') {
      if (input.pr !== undefined) {
        throw new InvalidInputError('`pr` needs kind "ui_check": a build task earns its own PR');
      }
      return null;
    }
    if (input.pr === undefined) {
      throw new InvalidInputError(
        'a "ui_check" task needs `pr`: the pull request to check, as a URL or "owner/name#41"',
      );
    }
    const requested = parsePullRequestRef(input.pr);
    if (requested.repo === null && input.repo === undefined) {
      throw new InvalidInputError(
        `pull request ${requested.number} does not say which repo it is in: pass a PR URL, "owner/name#${requested.number}", or \`repo\``,
      );
    }
    return requested;
  }

  /** A failed fetch here means the head is gone (deleted fork, private repo): say so as input. */
  private async checkoutPullRequest(
    taskId: string,
    targetRepo: { owner: string; name: string } | null,
    prNumber: number,
  ): Promise<{ branch: string; path: string }> {
    try {
      return await this.deps.worktrees.createForPullRequest(taskId, targetRepo, prNumber);
    } catch (error) {
      throw new InvalidInputError(
        `cannot check out pull request ${prNumber}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async resolve(repo: string): Promise<{ owner: string; name: string }> {
    try {
      return await this.deps.repos.resolve(repo);
    } catch (error) {
      throw new InvalidInputError(
        error instanceof Error ? error.message : `"${repo}" is not an allowed repo`,
      );
    }
  }
}
