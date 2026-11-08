import type { ArtifactName } from '@jarvis/shared';
import type { IsoTime } from '../../domain/index.js';

export interface ArtifactFile {
  readonly name: ArtifactName;
  readonly exists: boolean;
  /** Null until the worker wrote the file. */
  readonly content: string | null;
  readonly updatedAt: IsoTime | null;
}

/** One file under a task's artifacts directory, read as bytes (ADR-0023: PR screenshots). */
export interface ArtifactBlob {
  /** The file's base name, safe to send as an upload name. */
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly sizeBytes: number;
}

/** SDD artifacts are Markdown files the worker writes; the engine only reads them (ADR-0010). */
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
   * (ADR-0023). Used for the screenshots of the UI check, never for the SDD artifacts.
   */
  readImage(taskId: string, relativePath: string): Promise<ArtifactBlob>;
}
