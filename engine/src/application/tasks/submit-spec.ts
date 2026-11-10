import type { ArtifactName } from '@jarvis/shared';
import { resolveCheckCommands } from '../../domain/index.js';
import type { BodyOf } from '../conversation/message-bodies.js';
import { transact } from '../transaction.js';
import { InvalidInputError, NotFoundError } from '../errors.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { RepoInfo } from '../ports/repo-info.js';
import type { WorktreeManager } from '../ports/worktree-manager.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from './deps.js';
import { loadWorkerTask } from './guards.js';
import { worktreeFor } from './worktree-for.js';

const REVIEWED_ARTIFACTS = ['spec.md', 'plan.md'] as const satisfies readonly ArtifactName[];

export interface SubmitSpecInput {
  readonly summary: string;
  /** ADR-0022: the commands the engine runs before it opens the PR; may only narrow `AGENTS.md`'s. */
  readonly checkCommands?: readonly string[];
}

export type SubmitSpecResult =
  | { readonly cardId: string }
  | {
      readonly ok: false;
      readonly reason: 'checks_required' | 'checks_not_in_agents_md';
      readonly detail: string;
    };

/**
 * WRK-04: Context -> Spec Review, and a decision card with links to spec.md and plan.md.
 * ADR-0022: the card also carries the check commands the owner's approval will freeze; when none
 * can be fixed the submit is refused and the task stays in Context.
 */
export class SubmitSpec {
  constructor(
    private readonly deps: TaskDeps & {
      readonly artifacts: ArtifactStore;
      readonly repoInfo: RepoInfo;
      readonly worktrees: WorktreeManager;
    },
  ) {}

  /** For callers that need a card: a refusal is thrown. The tool route uses `attempt` and answers with the value. */
  async execute(identity: RunIdentity, input: SubmitSpecInput): Promise<{ cardId: string }> {
    const result = await this.attempt(identity, input);
    if ('cardId' in result) return result;
    throw new InvalidInputError(`${result.reason}: ${result.detail}`);
  }

  async attempt(identity: RunIdentity, input: SubmitSpecInput): Promise<SubmitSpecResult> {
    // The repository is read before the transaction: it is a file read, not database work.
    const target = await transact(this.deps, (tx) => loadWorkerTask(tx, identity));
    const worktree = await worktreeFor(this.deps.worktrees, target);
    const found = await this.deps.repoInfo.commands(worktree.path);
    const resolved = resolveCheckCommands({
      agentsMd: found.checkCommands,
      proposed: input.checkCommands,
    });
    return transact(this.deps, async (tx, outbox): Promise<SubmitSpecResult> => {
      const task = await loadWorkerTask(tx, identity);
      const written = (await this.deps.artifacts.list(task.id))
        .filter((file) => file.exists)
        .map((file) => file.name);
      for (const name of REVIEWED_ARTIFACTS) {
        if (!written.includes(name)) throw new NotFoundError('artifact', `${task.id}/${name}`);
      }

      if (!resolved.ok) {
        return {
          ok: false,
          reason: resolved.reason,
          detail:
            resolved.reason === 'checks_required'
              ? "No check commands: AGENTS.md names none and you passed no `checkCommands`. Find the repository's test, typecheck and lint commands (package scripts, CI workflows, README), pass them as `checkCommands`, or ask_owner when there are none."
              : `These \`checkCommands\` are not in AGENTS.md's list: ${resolved.offending.map((c) => `\`${c}\``).join(', ')}. With commands in AGENTS.md you may only leave some out, not add any.`,
        };
      }

      const { commands, source } = resolved;
      await this.deps.writer.note(tx, task.id, 'checks_declared', 'agent', { commands, source });
      const moved = await this.deps.writer.move(tx, outbox, task, 'Spec Review', {
        cause: 'spec_submitted',
      });
      const origin =
        source === 'agents_md'
          ? "from the repository's AGENTS.md"
          : 'found by the worker (AGENTS.md names none)';
      const summary = [
        input.summary,
        '',
        'Checks the engine will run before opening the PR:',
        ...commands.map((command) => `- \`${command}\``),
        `Source: ${origin}.`,
      ].join('\n');
      const body: BodyOf<'decision'> = {
        taskId: moved.id,
        summary,
        artifacts: [...REVIEWED_ARTIFACTS],
        checks: [...commands],
        checksSource: source,
      };
      const card = await this.deps.messages.post(tx, outbox, {
        threadId: moved.threadId,
        taskId: moved.id,
        kind: 'decision',
        body,
      });
      return { cardId: card.id };
    });
  }
}
