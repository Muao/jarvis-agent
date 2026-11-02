import { createTask } from '../../domain/index.js';
import { transact } from '../transaction.js';
import { ForbiddenError, NotFoundError } from '../errors.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { WorktreeManager } from '../ports/worktree-manager.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from './deps.js';
import { requireDispatcher } from './guards.js';

export interface CreateTaskInput {
  readonly title: string;
  readonly description: string;
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
    },
  ) {}

  async execute(identity: RunIdentity, input: CreateTaskInput): Promise<CreatedTask> {
    requireDispatcher(identity);
    return transact(this.deps, async (tx, outbox) => {
      const thread = await tx.threads.get(identity.threadId);
      if (thread === null) throw new NotFoundError('thread', identity.threadId);
      if ((await tx.tasks.activeForThread(thread.id)) !== null) {
        throw new ForbiddenError(`thread ${thread.id} already has an active task`);
      }

      const id = await tx.tasks.nextId();
      const worktree = await this.deps.worktrees.create(id);
      const task = createTask({
        id,
        threadId: thread.id,
        title: input.title,
        branch: worktree.branch,
        at: this.deps.clock.now(),
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
}
