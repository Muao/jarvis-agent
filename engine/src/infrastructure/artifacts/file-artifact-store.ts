import { mkdirSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { ArtifactNameSchema, type ArtifactName } from '@jarvis/shared';
import type {
  ArtifactBlob,
  ArtifactFile,
  ArtifactStore,
} from '../../application/ports/artifact-store.js';
import { InvalidInputError, NotFoundError } from '../../application/errors.js';

const TASK_ID = /^T-\d+$/;

/** ADR-0014: what GitHub renders inline in a PR body. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** True when `path` is inside `root` — `..` and absolute paths are not. */
function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep);
}

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

  /**
   * ADR-0014. Containment is checked twice: on the joined path, and again on the path with
   * symlinks resolved, so a link planted inside the directory cannot reach outside it.
   */
  async readImage(taskId: string, relativePath: string): Promise<ArtifactBlob> {
    const dir = await realpath(this.dirFor(taskId));
    const target = resolve(dir, relativePath);
    if (!isInside(dir, target)) {
      throw new InvalidInputError(
        `${JSON.stringify(relativePath)} is outside the task's artifacts directory`,
      );
    }

    const extension = Object.keys(IMAGE_TYPES).find((ext) => target.toLowerCase().endsWith(ext));
    if (extension === undefined) {
      throw new InvalidInputError(
        `${JSON.stringify(relativePath)} is not an image (${Object.keys(IMAGE_TYPES).join(', ')})`,
      );
    }

    let real: string;
    try {
      real = await realpath(target);
    } catch {
      throw new NotFoundError('screenshot', relativePath);
    }
    if (!isInside(dir, real)) {
      throw new InvalidInputError(
        `${JSON.stringify(relativePath)} resolves outside the task's artifacts directory`,
      );
    }

    const [bytes, info] = await Promise.all([readFile(real), stat(real)]);
    return {
      name: basename(real),
      bytes,
      contentType: IMAGE_TYPES[extension] as string,
      sizeBytes: info.size,
    };
  }

  async list(taskId: string): Promise<readonly Pick<ArtifactFile, 'name' | 'exists'>[]> {
    const files = await Promise.all(
      ArtifactNameSchema.options.map((name) => this.read(taskId, name)),
    );
    return files.map(({ name, exists }) => ({ name, exists }));
  }
}
