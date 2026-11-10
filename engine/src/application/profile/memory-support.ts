import { MemoryError, type Task } from '../../domain/index.js';
import { ForbiddenError, InvalidInputError, NotFoundError } from '../errors.js';
import type { RepoResolver } from '../ports/repo-resolver.js';

/** ADR-0021: the domain's `MemoryError` as the application's own error types. */
export function memoryFailure(error: unknown): unknown {
  if (!(error instanceof MemoryError)) return error;
  if (error.code === 'unknown_entry') {
    return new NotFoundError('memory entry', /m\d+/.exec(error.message)?.[0] ?? '');
  }
  return new InvalidInputError(error.message);
}

/** Runs `work`, turning a `MemoryError` into an application error. */
export async function guardMemory<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw memoryFailure(error);
  }
}

/**
 * ADR-0021 / ADR-0018: a `ui_check` worker reads a pull request head the owner may not trust, so
 * it reads the memory and writes none.
 */
export function requireBuildTask(task: Pick<Task, 'id' | 'kind'>): void {
  if (task.kind !== 'build') {
    throw new ForbiddenError(`task ${task.id} is a ${task.kind} task; it may not write the memory`);
  }
}

/** `owner/name` of the repository a task works in: its target repo, else the configured default. */
export function taskRepoSlug(
  task: Pick<Task, 'targetRepo'>,
  repos: Pick<RepoResolver, 'defaultRepo'>,
): string | null {
  const repo = task.targetRepo ?? repos.defaultRepo();
  return repo === null ? null : `${repo.owner}/${repo.name}`;
}

/** Same, but an entry cannot be written without a repository to scope it to. */
export function requireTaskRepo(
  task: Pick<Task, 'targetRepo'>,
  repos: Pick<RepoResolver, 'defaultRepo'>,
): string {
  const slug = taskRepoSlug(task, repos);
  if (slug === null) {
    throw new InvalidInputError(
      'cannot tell which repository this task works in, so an entry cannot be scoped to it',
    );
  }
  return slug;
}
