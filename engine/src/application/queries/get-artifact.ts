import type { ArtifactDto, ArtifactName } from '@jarvis/shared';
import { NotFoundError } from '../errors.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** `GET /api/tasks/:id/artifacts/:name`. A file the worker has not written yet is a normal answer, not an error. */
export class GetArtifact {
  constructor(
    private readonly deps: { readonly uow: UnitOfWork; readonly artifacts: ArtifactStore },
  ) {}

  async execute(taskId: string, name: ArtifactName): Promise<ArtifactDto> {
    const task = await this.deps.uow.run((tx) => tx.tasks.get(taskId));
    if (task === null) throw new NotFoundError('task', taskId);
    const file = await this.deps.artifacts.read(taskId, name);
    return {
      name: file.name,
      exists: file.exists,
      content: file.content,
      updatedAt: file.updatedAt,
    };
  }
}
