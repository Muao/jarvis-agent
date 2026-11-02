import { mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ArtifactNameSchema, type ArtifactName } from '@jarvis/shared';
import type { ArtifactFile, ArtifactStore } from '../../application/ports/artifact-store.js';

const TASK_ID = /^T-\d+$/;

/** SDD artifacts under `<tasksDir>/<taskId>/`; only the five known names are addressable. */
export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly tasksDir: string) {}

  dirFor(taskId: string): string {
    if (!TASK_ID.test(taskId)) throw new Error(`Invalid task id: ${JSON.stringify(taskId)}`);
    const dir = join(this.tasksDir, taskId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  async read(taskId: string, name: ArtifactName): Promise<ArtifactFile> {
    const known = ArtifactNameSchema.parse(name);
    const file = join(this.dirFor(taskId), known);
    try {
      const [content, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
      return { name: known, exists: true, content, updatedAt: info.mtime.toISOString() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { name: known, exists: false, content: null, updatedAt: null };
      }
      throw error;
    }
  }

  async list(taskId: string): Promise<readonly Pick<ArtifactFile, 'name' | 'exists'>[]> {
    const files = await Promise.all(
      ArtifactNameSchema.options.map((name) => this.read(taskId, name)),
    );
    return files.map(({ name, exists }) => ({ name, exists }));
  }
}
