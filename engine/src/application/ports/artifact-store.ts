import type { ArtifactName } from '@jarvis/shared';
import type { IsoTime } from '../../domain/index.js';

export interface ArtifactFile {
  readonly name: ArtifactName;
  readonly exists: boolean;
  /** Null until the worker wrote the file. */
  readonly content: string | null;
  readonly updatedAt: IsoTime | null;
}

/** SDD artifacts are Markdown files the worker writes; the engine only reads them (ADR-0010). */
export interface ArtifactStore {
  /** The folder the worker writes into. */
  dirFor(taskId: string): string;
  /** One artifact with its content and modification time; a file not written yet has `exists: false`. */
  read(taskId: string, name: ArtifactName): Promise<ArtifactFile>;
  /** All five artifact names, each with whether it was written. */
  list(taskId: string): Promise<readonly Pick<ArtifactFile, 'name' | 'exists'>[]>;
}
