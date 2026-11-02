import { readFile, stat } from 'node:fs/promises';
import type { ProfileFile, ProfileFiles } from '../../application/ports/profile-files.js';

async function readProfileFile(path: string): Promise<ProfileFile> {
  try {
    const [content, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return { path, content, modifiedAt: info.mtime.toISOString() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, content: null, modifiedAt: null };
    }
    throw error;
  }
}

/** `SOUL.md` and `USER.md` for the Config screen; read fresh each time. A missing file is shown as empty, not as an error. */
export class FileProfileFiles implements ProfileFiles {
  constructor(private readonly paths: { readonly soul: string; readonly user: string }) {}

  async read(): Promise<{ soul: ProfileFile; user: ProfileFile }> {
    const [soul, user] = await Promise.all([
      readProfileFile(this.paths.soul),
      readProfileFile(this.paths.user),
    ]);
    return { soul, user };
  }
}
