import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileOwnerPluginStore } from './file-owner-plugin-store.js';

describe('FileOwnerPluginStore', () => {
  let root: string;
  let plugin: string;
  let backups: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jarvis-owner-plugin-'));
    plugin = join(root, 'plugin');
    backups = join(root, 'plugin-backups');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const store = (backupsKept?: number) =>
    new FileOwnerPluginStore({
      pluginDir: plugin,
      backupsDir: backups,
      ...(backupsKept === undefined ? {} : { backupsKept }),
    });

  it('creates the plugin manifest and a skill on first write', async () => {
    const result = await store().put('skills', 'my-skill', { description: 'Does x', body: '# Hi' });

    expect(result).toEqual({ created: true });
    const manifest = JSON.parse(
      readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { name: string };
    expect(manifest.name).toBe('jarvis-owner');
    const file = readFileSync(join(plugin, 'skills', 'my-skill', 'SKILL.md'), 'utf8');
    expect(file).toBe('---\nname: my-skill\ndescription: "Does x"\n---\n\n# Hi\n');
  });

  it('writes a subagent with tools and model, and reads it back', async () => {
    await store().put('agents', 'helper', {
      description: 'Helps',
      body: 'Do things.',
      tools: ['Read', 'Grep'],
      model: 'opus',
    });

    expect(existsSync(join(plugin, 'agents', 'helper.md'))).toBe(true);
    const doc = await store().get('agents', 'helper');
    expect(doc).toMatchObject({
      name: 'helper',
      description: 'Helps',
      body: 'Do things.\n',
      tools: ['Read', 'Grep'],
      model: 'opus',
    });
    expect(doc?.markdown).toContain('model: opus');
  });

  it('returns null for something that is not there', async () => {
    expect(await store().get('skills', 'nope')).toBeNull();
  });

  it('backs up the previous version before an overwrite', async () => {
    await store().put('skills', 's', { description: 'first', body: 'one' });
    expect(existsSync(backups)).toBe(false);

    const second = await store().put('skills', 's', { description: 'second', body: 'two' });

    expect(second).toEqual({ created: false });
    const copies = readdirSync(backups);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatch(/\.skills\.s\.md$/);
    expect(readFileSync(join(backups, copies[0] as string), 'utf8')).toContain('first');
    expect((await store().get('skills', 's'))?.description).toBe('second');
  });

  it('backs up before a delete, removes the file and the empty skill folder', async () => {
    await store().put('skills', 's', { description: 'd', body: 'b' });

    expect(await store().delete('skills', 's')).toBe(true);

    expect(existsSync(join(plugin, 'skills', 's'))).toBe(false);
    expect(readdirSync(backups)).toHaveLength(1);
    expect(await store().delete('skills', 's')).toBe(false);
  });

  it('keeps a skill folder that holds other files', async () => {
    await store().put('skills', 's', { description: 'd', body: 'b' });
    writeFileSync(join(plugin, 'skills', 's', 'helper.sh'), 'echo');

    await store().delete('skills', 's');

    expect(existsSync(join(plugin, 'skills', 's', 'helper.sh'))).toBe(true);
    expect(existsSync(join(plugin, 'skills', 's', 'SKILL.md'))).toBe(false);
  });

  it('keeps only the last N backups', async () => {
    const s = store(3);
    await s.put('agents', 'a', { description: 'v0', body: '' });
    for (let i = 1; i <= 6; i += 1) {
      await s.put('agents', 'a', { description: `v${i}`, body: '' });
    }

    const copies = readdirSync(backups).sort();
    expect(copies).toHaveLength(3);
    // The newest three: the versions that were replaced last (v3, v4, v5).
    const bodies = copies.map((f) => readFileSync(join(backups, f), 'utf8'));
    expect(bodies.map((b) => /description: "(v\d)"/.exec(b)?.[1])).toEqual(['v3', 'v4', 'v5']);
  });

  it('serialises concurrent writes', async () => {
    const s = store();
    await Promise.all(
      [1, 2, 3, 4].map((n) => s.put('skills', 'race', { description: `v${n}`, body: '' })),
    );
    expect((await s.get('skills', 'race'))?.description).toBe('v4');
    expect(readdirSync(backups)).toHaveLength(3);
  });

  it('does not touch an existing manifest', async () => {
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
    writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"mine"}');

    await store().put('skills', 's', { description: 'd', body: '' });

    expect(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')).toBe(
      '{"name":"mine"}',
    );
  });
});
