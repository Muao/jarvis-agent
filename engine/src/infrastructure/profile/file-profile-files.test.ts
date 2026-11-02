import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileProfileFiles } from './file-profile-files.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jarvis-profile-files-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FileProfileFiles', () => {
  it('returns content and modification time, reading fresh each time', async () => {
    const soul = join(dir, 'SOUL.md');
    const user = join(dir, 'USER.md');
    await writeFile(soul, 'Be brief.');
    await utimes(soul, new Date('2026-01-01T08:00:00.000Z'), new Date('2026-01-01T08:00:00.000Z'));
    const files = new FileProfileFiles({ soul, user });

    const first = await files.read();
    expect(first.soul).toEqual({
      path: soul,
      content: 'Be brief.',
      modifiedAt: '2026-01-01T08:00:00.000Z',
    });
    expect(first.user).toEqual({ path: user, content: null, modifiedAt: null });

    await writeFile(user, 'Reply in Ukrainian.');
    expect((await files.read()).user).toMatchObject({ content: 'Reply in Ukrainian.' });
  });
});
