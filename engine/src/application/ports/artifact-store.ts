import type { ArtifactName } from '@jarvis/shared';
import type { IsoTime } from '../../domain/index.js';

export interface ArtifactFile {
  readonly name: ArtifactName;
  readonly exists: boolean;
  /** Null until the worker wrote the file. */
  readonly content: string | null;
  readonly updatedAt: IsoTime | null;
}

/** One file under a task's artifacts directory, read as bytes (ADR-0014: PR screenshots). */
export interface ArtifactBlob {
  /** The file's base name, safe to send as an upload name. */
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly sizeBytes: number;
}

/** SDD artifacts are Markdown files the worker writes; the engine only reads them (ADR-0008). */
export interface ArtifactStore {
  /** The folder the worker writes into. */
  dirFor(taskId: string): string;
  /** One artifact with its content and modification time; a file not written yet has `exists: false`. */
  read(taskId: string, name: ArtifactName): Promise<ArtifactFile>;
  /** All five artifact names, each with whether it was written. */
  list(taskId: string): Promise<readonly Pick<ArtifactFile, 'name' | 'exists'>[]>;
  /**
   * Any file under the task's artifacts directory, by a relative path, as bytes. Rejects a path
   * that leaves the directory, a type that is not an image, and a file that does not exist
   * (ADR-0014). Used for the screenshots of the UI check, never for the SDD artifacts.
   */
  readImage(taskId: string, relativePath: string): Promise<ArtifactBlob>;
  /**
   * ADR-0022: a file the engine writes for the worker (a check log, a failed CI log) under the
   * task's artifacts directory — never in the worktree. Creates directories, replaces atomically,
   * rejects an absolute path and any `..` segment.
   */
  writeEngineFile(taskId: string, relativePath: string, content: string): Promise<void>;
}
