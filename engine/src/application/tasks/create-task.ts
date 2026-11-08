import { createTask } from '../../domain/index.js';
import { transact } from '../transaction.js';
import { ForbiddenError, InvalidInputError, NotFoundError } from '../errors.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { RepoResolver } from '../ports/repo-resolver.js';
import type { WorktreeManager } from '../ports/worktree-manager.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from './deps.js';
import { requireDispatcher } from './guards.js';

export interface CreateTaskInput {
  readonly title: string;
  readonly description: string;
  /** ADR-0019: the repo to create the task's worktree in, besides the configured default. */
  readonly repo?: string;
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
    const targetRepo = input.repo === undefined ? null : await this.resolve(input.repo);
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
      const worktree = await this.deps.worktrees.create(id, targetRepo);
      const task = createTask({
        id,
        threadId: thread.id,
        title: input.title,
        branch: worktree.branch,
        at: this.deps.clock.now(),
        targetRepo,
      });
      await this.deps.writer.update(tx, outbox, task, 'task_created', 'agent', {
        title: input.title,
        description: input.description,
        branch: worktree.branch,
      });
      outbox.requestWorkerRun(id, 'start');
      return { taskId: id, branch: worktree.branch };
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
