import type { ArtifactName } from '@jarvis/shared';
import type { BodyOf } from '../conversation/message-bodies.js';
import { transact } from '../transaction.js';
import { NotFoundError } from '../errors.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from './deps.js';
import { loadWorkerTask } from './guards.js';

const REVIEWED_ARTIFACTS = ['spec.md', 'plan.md'] as const satisfies readonly ArtifactName[];

/** WRK-04: Context -> Spec Review, and a decision card with links to spec.md and plan.md. */
export class SubmitSpec {
  constructor(private readonly deps: TaskDeps & { readonly artifacts: ArtifactStore }) {}

  execute(identity: RunIdentity, input: { readonly summary: string }): Promise<{ cardId: string }> {
    return transact(this.deps, async (tx, outbox) => {
      const task = await loadWorkerTask(tx, identity);
      const written = (await this.deps.artifacts.list(task.id))
        .filter((file) => file.exists)
        .map((file) => file.name);
      for (const name of REVIEWED_ARTIFACTS) {
        if (!written.includes(name)) throw new NotFoundError('artifact', `${task.id}/${name}`);
      }

      const moved = await this.deps.writer.move(tx, outbox, task, 'Spec Review', {
        cause: 'spec_submitted',
      });
      const body: BodyOf<'decision'> = {
        taskId: moved.id,
        summary: input.summary,
        artifacts: [...REVIEWED_ARTIFACTS],
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
