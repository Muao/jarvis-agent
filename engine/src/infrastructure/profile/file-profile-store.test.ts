import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

describe('FileProfileStore.appendLearned (ADR-0013)', () => {
  it('creates a minimal file with just the heading and the fact when USER.md does not exist', async () => {
    const file = join(dir, 'USER.md');
    const store = new FileProfileStore(file);

    await store.appendLearned('the QuickBlog repo is burnjohn/quick-blog');

    expect(await readFile(file, 'utf8')).toBe(
      '## Learned\n\n- the QuickBlog repo is burnjohn/quick-blog\n',
    );
  });

  it("creates the heading at end-of-file when missing, without touching the owner's content", async () => {
    const file = join(dir, 'USER.md');
    const owner = '# Owner preferences\n\n## Language\n\n- English\n';
    await writeFile(file, owner);
    const store = new FileProfileStore(file);

    await store.appendLearned('ship on Fridays');

    const result = await readFile(file, 'utf8');
    expect(result.startsWith(owner)).toBe(true);
    expect(result).toBe(`${owner}\n## Learned\n\n- ship on Fridays\n`);
  });

  it('appends under an existing ## Learned section, leaving everything outside it byte-identical', async () => {
    const file = join(dir, 'USER.md');
    const before = '# Owner preferences\n\n## Language\n\n- English\n\n';
    const learned = '## Learned\n\n- existing fact\n';
    const after = '\n## Other\n\n- always ask before deploying\n';
    await writeFile(file, before + learned + after);
    const store = new FileProfileStore(file);

    await store.appendLearned('a new fact');

    const result = await readFile(file, 'utf8');
    expect(result.startsWith(before)).toBe(true);
    expect(result.endsWith(after)).toBe(true);
    const middle = result.slice(before.length, result.length - after.length);
    expect(middle).toBe('## Learned\n\n- existing fact\n- a new fact\n');
  });

  it('lands two consecutive calls as separate bullets, in order', async () => {
    const file = join(dir, 'USER.md');
    const store = new FileProfileStore(file);

    await store.appendLearned('fact one');
    await store.appendLearned('fact two');

    expect(await readFile(file, 'utf8')).toBe('## Learned\n\n- fact one\n- fact two\n');
  });
});
