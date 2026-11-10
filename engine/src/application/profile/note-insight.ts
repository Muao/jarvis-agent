import { addAgentEntry, formatLocalMinute, parseMemory, spliceMemory } from '../../domain/index.js';
import { InvalidInputError } from '../errors.js';
import type { ProfileStore } from '../ports/profile-store.js';
import type { RepoResolver } from '../ports/repo-resolver.js';
import type { WorktreeManager } from '../ports/worktree-manager.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from '../tasks/deps.js';
import { loadWorkerTask } from '../tasks/guards.js';
import { worktreeFor } from '../tasks/worktree-for.js';
import { transact } from '../transaction.js';
import { guardMemory, requireBuildTask, requireTaskRepo } from './memory-support.js';

export interface NoteInsightDeps extends TaskDeps {
  readonly profile: ProfileStore;
  readonly repos: RepoResolver;
  readonly worktrees: WorktreeManager;
}

const GITHUB_URL = 'https://github.com/';
const PATH_LINE = /^([^\s:]+):(\d+)$/;

/**
 * ADR-0021: the worker's `note_insight`. A new agent entry at ✓1, always under the task's own
 * repository, written at once. Every citation must be checkable: a `path:line` names a file that
 * exists in the task's worktree, or the citation is a GitHub URL.
 */
export class NoteInsight {
  constructor(private readonly deps: NoteInsightDeps) {}

  execute(
    identity: RunIdentity,
    input: { readonly fact: string; readonly citations: readonly string[] },
  ): Promise<{ id: string }> {
    return transact(this.deps, async (tx) => {
      const task = await loadWorkerTask(tx, identity);
      requireBuildTask(task);
      const repo = requireTaskRepo(task, this.deps.repos);
      await this.checkCitations(task, input.citations);

      const at = formatLocalMinute(this.deps.clock.now());
      const { id } = await guardMemory(() =>
        this.deps.profile.mutate((current) => {
          const { document, id } = addAgentEntry(parseMemory(current), {
            fact: input.fact,
            repo,
            citations: input.citations,
            task: task.id,
            at,
          });
          return { content: spliceMemory(current, document), result: { id } };
        }),
      );
      await this.deps.writer.note(tx, task.id, 'memory_noted', 'agent', {
        entryId: id,
        fact: input.fact.trim(),
        citations: input.citations,
      });
      return { id };
    });
  }

  private async checkCitations(
    task: Parameters<typeof worktreeFor>[1],
    citations: readonly string[],
  ): Promise<void> {
    const worktree = await worktreeFor(this.deps.worktrees, task);
    for (const citation of citations) {
      if (citation.startsWith(GITHUB_URL)) continue;
      const match = PATH_LINE.exec(citation);
      if (match === null) {
        throw new InvalidInputError(
          `citation "${citation}" is neither path:line nor an ${GITHUB_URL} URL`,
        );
      }
      const path = match[1] as string;
      const climbs = path.startsWith('/') || path.split('/').includes('..');
      if (climbs || !(await this.deps.worktrees.hasFile(worktree.path, path))) {
        throw new InvalidInputError(
          `citation "${citation}": there is no file ${path} in this task's worktree`,
        );
      }
    }
  }
}
