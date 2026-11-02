import { readFile } from 'node:fs/promises';

/** Structural match for the application's ProfileStore port. */
export interface UserPreferencesSource {
  userPreferences(): Promise<string | null>;
}

/** Reads `USER.md` fresh on every call, so an edit applies to the next run (PRF-03). Missing file means no preferences. */
export class FileProfileStore implements UserPreferencesSource {
  constructor(private readonly userFile: string) {}

  async userPreferences(): Promise<string | null> {
    try {
      return await readFile(this.userFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}
