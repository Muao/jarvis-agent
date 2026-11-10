import { addOwnerEntry, formatLocalMinute, parseMemory, spliceMemory } from '../../domain/index.js';
import { InvalidInputError } from '../errors.js';
import type { ProfileStore } from '../ports/profile-store.js';
import type { RepoResolver } from '../ports/repo-resolver.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from '../tasks/deps.js';
import { loadWorkerTask } from '../tasks/guards.js';
import { transact } from '../transaction.js';
import { guardMemory, requireBuildTask, requireTaskRepo } from './memory-support.js';

export interface RememberOwnerDeps extends TaskDeps {
  readonly profile: ProfileStore;
  readonly repos: RepoResolver;
}

const MIN_QUOTE = 8;

/**
 * ADR-0021: the worker's `remember_owner`. An owner entry (`owner via T-n`) from words the owner
 * wrote in this task's thread. The engine accepts it only when `quote` occurs verbatim in a message
 * the owner typed — not in the worker's own text, a system line, or the review comments and CI logs
 * that the engine also stores as `owner` messages (their `source` is not `owner`).
 */
export class RememberOwner {
  constructor(private readonly deps: RememberOwnerDeps) {}

  execute(
    identity: RunIdentity,
    input: { readonly fact: string; readonly quote: string; readonly everywhere?: boolean },
  ): Promise<{ id: string }> {
    return transact(this.deps, async (tx) => {
      const task = await loadWorkerTask(tx, identity);
      requireBuildTask(task);
      if (input.quote.trim().length < MIN_QUOTE) {
        throw new InvalidInputError(
          `quote must be at least ${MIN_QUOTE} characters of the owner's words`,
        );
      }
      const thread = await tx.messages.listByThread(task.threadId);
      const source = [...thread]
        .reverse()
        .find(
          (m) =>
            m.kind === 'owner' &&
            m.body.source === 'owner' &&
            typeof m.body.text === 'string' &&
            m.body.text.includes(input.quote),
        );
      if (source === undefined) {
        throw new InvalidInputError(
          "quote does not occur verbatim in any message the owner wrote in this task's thread",
        );
      }
      const repo = input.everywhere === true ? null : requireTaskRepo(task, this.deps.repos);

      const at = formatLocalMinute(this.deps.clock.now());
      const { id } = await guardMemory(() =>
        this.deps.profile.mutate((current) => {
          const { document, id } = addOwnerEntry(parseMemory(current), {
            fact: input.fact,
            repo,
            at,
            via: task.id,
            source: `message ${source.id}`,
          });
          return { content: spliceMemory(current, document), result: { id } };
        }),
      );
      await this.deps.writer.note(tx, task.id, 'memory_owner_recorded', 'agent', {
        entryId: id,
        messageId: source.id,
      });
      return { id };
    });
  }
}
