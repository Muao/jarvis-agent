import type { Task } from '../../domain/index.js';
import type { Worktree, WorktreeManager } from '../ports/worktree-manager.js';

/**
 * ADR-0018: both kinds of task keep their worktree at the same path, so whoever asks for it has to
 * ask for the right branch. A `ui_check` task stands on the pull request's head
 * (`jarvis-check/<id>`); a `build` task on its own `jarvis/<id>`. Asking for the wrong one fails
 * loudly ("exists but is on …"), which is why this lives in one place.
 */
export function worktreeFor(
  worktrees: WorktreeManager,
  task: Pick<Task, 'id' | 'kind' | 'pr' | 'targetRepo'>,
): Promise<Worktree> {
  return task.kind === 'ui_check' && task.pr !== null
    ? worktrees.createForPullRequest(task.id, task.targetRepo, task.pr.number)
    : worktrees.create(task.id, task.targetRepo);
}
