import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

/** The ADR-0021 write path: a pure edit of the whole file text. */
const append = (line: string) => (current: string) => ({
  content: `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${line}\n`,
  result: line,
});

describe('FileProfileStore.mutate (ADR-0021)', () => {
  it('creates the file when it does not exist', async () => {
    const file = join(dir, 'USER.md');
    const store = new FileProfileStore(file);

    await store.mutate(append('- one'));

    expect(await readFile(file, 'utf8')).toBe('- one\n');
  });

  it('returns what the edit returns, and writes nothing for an unchanged text', async () => {
    const file = join(dir, 'USER.md');
    const store = new FileProfileStore(file);

    expect(await store.mutate((current) => ({ content: current, result: 42 }))).toBe(42);
    expect(await store.userPreferences()).toBeNull();
  });

  it('reads the file fresh inside each call, so a hand edit between two calls survives', async () => {
    const file = join(dir, 'USER.md');
    const store = new FileProfileStore(file);
    await store.mutate(append('- first'));

    await writeFile(file, `${await readFile(file, 'utf8')}hand-written\n`);
    await store.mutate(append('- second'));

    expect(await readFile(file, 'utf8')).toBe('- first\nhand-written\n- second\n');
  });

  it('keeps 20 parallel mutations, each seeing the previous result', async () => {
    const file = join(dir, 'USER.md');
    const store = new FileProfileStore(file);

    await Promise.all(Array.from({ length: 20 }, (_, i) => store.mutate(append(`- entry ${i}`))));

    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(20);
    expect(new Set(lines).size).toBe(20);
  });

  it('leaves the file untouched and the queue alive when an edit throws', async () => {
    const file = join(dir, 'USER.md');
    const store = new FileProfileStore(file);
    await store.mutate(append('- kept'));

    await expect(
      store.mutate(() => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    await store.mutate(append('- after'));

    expect(await readFile(file, 'utf8')).toBe('- kept\n- after\n');
  });

  it('leaves no temporary file behind', async () => {
    const file = join(dir, 'USER.md');
    const store = new FileProfileStore(file);

    await Promise.all([1, 2, 3].map((n) => store.mutate(append(`- ${n}`))));

    expect(await readdir(dir)).toEqual(['USER.md']);
  });

  it('read() gives the raw text, empty when the file is missing', async () => {
    const file = join(dir, 'USER.md');
    const store = new FileProfileStore(file);
    expect(await store.read()).toBe('');
    await writeFile(file, 'raw\n');
    expect(await store.read()).toBe('raw\n');
  });

  it('copies the file to backups/ first when asked, and prunes to backupsKept', async () => {
    const file = join(dir, 'USER.md');
    const store = new FileProfileStore(file, { backupsKept: 3 });
    await store.mutate(append('- v0'));

    for (let i = 1; i <= 5; i++) await store.mutate(append(`- v${i}`), { backup: true });

    const backups = (await readdir(join(dir, 'backups'))).sort();
    expect(backups).toHaveLength(3);
    expect(backups.every((name) => name.startsWith('USER.md.'))).toBe(true);
    // The newest copy holds the text from just before the last write.
    const newest = await readFile(join(dir, 'backups', backups[2] as string), 'utf8');
    expect(newest).toBe('- v0\n- v1\n- v2\n- v3\n- v4\n');
  });

  it('takes no backup unless asked', async () => {
    const file = join(dir, 'USER.md');
    const store = new FileProfileStore(file);
    await store.mutate(append('- a'));
    await store.mutate(append('- b'));
    expect(await readdir(dir)).toEqual(['USER.md']);
  });
});
