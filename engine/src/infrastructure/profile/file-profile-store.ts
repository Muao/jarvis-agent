import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Structural match for the application's ProfileStore port. */
export interface UserPreferencesSource {
  userPreferences(): Promise<string | null>;
  read(): Promise<string>;
  mutate<T>(
    fn: (current: string) => { content: string; result: T },
    options?: { backup?: boolean },
  ): Promise<T>;
}

export interface FileProfileStoreOptions {
  /** Where `forget` / `merge_insights` copies go; default `<dir of USER.md>/backups`. */
  readonly backupsDir?: string;
  /** How many copies to keep (`memory.backupsKept`); a function is read at each prune. */
  readonly backupsKept?: number | (() => number);
}

const DEFAULT_BACKUPS_KEPT = 20;

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Reads `USER.md` fresh on every call, so an edit applies to the next run (PRF-03). Every write
 * goes through one in-process queue, re-reads the file inside it, and replaces the file by
 * renaming a temporary file over it (ADR-0021).
 */
export class FileProfileStore implements UserPreferencesSource {
  private queue: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private readonly backupsDir: string;
  private readonly backupsKept: number | (() => number);

  constructor(
    private readonly userFile: string,
    options: FileProfileStoreOptions = {},
  ) {
    this.backupsDir = options.backupsDir ?? join(dirname(userFile), 'backups');
    this.backupsKept = options.backupsKept ?? DEFAULT_BACKUPS_KEPT;
  }

  /** Missing file means no preferences. */
  userPreferences(): Promise<string | null> {
    return readOrNull(this.userFile);
  }

  async read(): Promise<string> {
    return (await readOrNull(this.userFile)) ?? '';
  }

  mutate<T>(
    fn: (current: string) => { content: string; result: T },
    options: { backup?: boolean } = {},
  ): Promise<T> {
    const run = this.queue.then(() => this.apply(fn, options.backup === true));
    // A failed edit must not poison the queue for the next one.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async apply<T>(
    fn: (current: string) => { content: string; result: T },
    backup: boolean,
  ): Promise<T> {
    const current = await readOrNull(this.userFile);
    const edit = fn(current ?? '');
    if (current !== null && edit.content === current) return edit.result;
    if (current === null && edit.content === '') return edit.result;

    if (backup && current !== null) await this.backUp();
    await mkdir(dirname(this.userFile), { recursive: true });
    const temporary = join(
      dirname(this.userFile),
      `.${basename(this.userFile)}.${process.pid}.${this.sequence++}.tmp`,
    );
    try {
      await writeFile(temporary, edit.content, 'utf8');
      await rename(temporary, this.userFile);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return edit.result;
  }

  private async backUp(): Promise<void> {
    await mkdir(this.backupsDir, { recursive: true });
    const name = basename(this.userFile);
    const stamp = new Date().toISOString().replace(/[-:.]/g, '');
    // The counter keeps names sortable and unique when two backups share a millisecond.
    const suffix = String(this.sequence++).padStart(6, '0');
    await copyFile(this.userFile, join(this.backupsDir, `${name}.${stamp}-${suffix}`));

    const kept = Math.max(
      1,
      typeof this.backupsKept === 'function' ? this.backupsKept() : this.backupsKept,
    );
    const copies = (await readdir(this.backupsDir))
      .filter((entry) => entry.startsWith(`${name}.`))
      .sort();
    for (const stale of copies.slice(0, Math.max(0, copies.length - kept))) {
      await rm(join(this.backupsDir, stale), { force: true });
    }
  }
}
