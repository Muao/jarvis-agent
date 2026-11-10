import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureHome, jarvisHome } from './jarvis-home.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('jarvisHome', () => {
  it('lays out paths per ADR-0009', () => {
    const h = jarvisHome('/j');
    expect(h.userFile).toBe('/j/USER.md');
    expect(h.configFile).toBe('/j/jarvis.config.json');
    expect(h.envFile).toBe('/j/.env');
    expect(h.mcpServersFile).toBe('/j/mcp/servers.json');
    expect(h.dispatcherDir).toBe('/j/dispatcher');
    expect(h.ownerPluginDir).toBe('/j/plugin');
    expect(h.pluginBackupsDir).toBe('/j/plugin-backups');
    expect(h.worktreeDir('T-1')).toBe('/j/worktrees/T-1');
    expect(h.taskDir('T-1')).toBe('/j/tasks/T-1');
    expect(h.runDir('r1')).toBe('/j/runs/r1');
  });

  it('rejects ids that escape the home', () => {
    const h = jarvisHome('/j');
    expect(() => h.runDir('../x')).toThrow();
    expect(() => h.taskDir('a/b')).toThrow();
    expect(() => h.worktreeDir('')).toThrow();
  });

  it('ensureHome creates the directories and is idempotent', async () => {
    const root = join(await mkdtemp(join(tmpdir(), 'jarvis-home-')), 'home');
    dirs.push(root);
    const h = jarvisHome(root);
    await ensureHome(h);
    await ensureHome(h);
    for (const d of ['mcp', 'dispatcher', 'worktrees', 'tasks', 'runs']) {
      expect((await stat(join(root, d))).isDirectory()).toBe(true);
    }
  });
});
