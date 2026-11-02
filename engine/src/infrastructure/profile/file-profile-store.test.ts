import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileProfileStore } from './file-profile-store.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jarvis-profile-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('FileProfileStore', () => {
  it('returns null when USER.md does not exist', async () => {
    expect(await new FileProfileStore(join(dir, 'USER.md')).userPreferences()).toBeNull();
  });

  it('reads the file fresh on every call', async () => {
    const file = join(dir, 'USER.md');
    const store = new FileProfileStore(file);
    await writeFile(file, 'prefer tabs');
    expect(await store.userPreferences()).toBe('prefer tabs');
    await writeFile(file, 'prefer spaces');
    expect(await store.userPreferences()).toBe('prefer spaces');
  });
});
