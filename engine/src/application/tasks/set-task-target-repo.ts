import { setTargetRepo } from '../../domain/index.js';
import { InvalidInputError } from '../errors.js';
import type { RepoResolver } from '../ports/repo-resolver.js';
import type { RunIdentity } from '../run-identity.js';
import { transact } from '../transaction.js';
import type { TaskDeps } from './deps.js';
import { loadTask, requireDispatcher } from './guards.js';

function sameRepo(
  a: { owner: string; name: string } | null,
  b: { owner: string; name: string },
): boolean {
  return a !== null && a.owner === b.owner && a.name === b.name;
}

export interface SetTaskTargetRepoInput {
  readonly taskId: string;
  /** `"owner/name"` (ADR-0019). */
  readonly repo: string;
}

/**
 * ADR-0019: names the repo a task's worktree is created in, besides the configured default.
 * Rejects with a clear reason (not a 500) when the repo is neither allow-listed nor owned by the
 * account `GITHUB_TOKEN` authenticates as, so the dispatcher can tell the owner why.
 *
 * A task's worktree is always created at `create_task` time (ADR-0019 follow-up), so by the time a
 * task id exists to call this with, the worktree is already fixed to whatever repo it was created
 * against. Changing to a *different* repo here can never take effect: it would silently no-op
 * against the real worktree manager (idempotent per task id), so this rejects instead of pretending
 * to succeed. Calling it again with the same repo the task already has is a harmless no-op.
 */
export class SetTaskTargetRepo {
  constructor(private readonly deps: TaskDeps & { readonly repos: RepoResolver }) {}

  async execute(identity: RunIdentity, input: SetTaskTargetRepoInput): Promise<void> {
    requireDispatcher(identity);
    const targetRepo = await this.resolve(input.repo);
    return transact(this.deps, async (tx, outbox) => {
      const task = await loadTask(tx, input.taskId);
      if (!sameRepo(task.targetRepo, targetRepo)) {
        throw new InvalidInputError(
          `task ${task.id}'s worktree already exists for ` +
            `${task.targetRepo === null ? 'the default repo' : `"${task.targetRepo.owner}/${task.targetRepo.name}"`}; ` +
            `it cannot be moved to "${targetRepo.owner}/${targetRepo.name}" now. Pass repo to create_task instead.`,
        );
      }
      await this.deps.writer.update(
        tx,
        outbox,
        setTargetRepo(task, targetRepo, this.deps.clock.now()),
        'target_repo_set',
        'agent',
        { owner: targetRepo.owner, name: targetRepo.name },
      );
    });
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
