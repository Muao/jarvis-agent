import type { IsoTime } from '../../domain/index.js';

export interface ProfileFile {
  readonly path: string;
  /** Null when the file does not exist. */
  readonly content: string | null;
  readonly modifiedAt: IsoTime | null;
}

/** `SOUL.md` and `USER.md` as files, for the read-only view on the Config screen (PRF-03). */
export interface ProfileFiles {
  read(): Promise<{ readonly soul: ProfileFile; readonly user: ProfileFile }>;
}
