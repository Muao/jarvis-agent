import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JarvisConfig } from '@jarvis/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileConfigProvider } from './file-config-provider.js';
import { StartupError } from './startup-error.js';

let dir: string;
let file: string;
let provider: FileConfigProvider | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jarvis-config-'));
  file = join(dir, 'jarvis.config.json');
});
afterEach(async () => {
  provider?.close();
  provider = undefined;
  await rm(dir, { recursive: true, force: true });
});

const write = (value: unknown) =>
  writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('FileConfigProvider.load', () => {
  it('loads a valid file, applies defaults and freezes the snapshot', async () => {
    await write({ repo: { path: '/r' } });
    provider = new FileConfigProvider(file);
    const config = provider.load();
    expect(config.repo).toEqual({ path: '/r', remote: 'origin', baseBranch: 'main' });
    expect(config.limits.maxTurnsPerRun).toBe(60);
    expect(provider.current()).toBe(config);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.limits)).toBe(true);
    expect(provider.loadedAt()).not.toBeNull();
    expect(provider.lastError()).toBeNull();
  });

  it('reports field-level errors as path: message lines', async () => {
    await write({ repo: { path: '/r' }, limits: { maxTurnsPerRun: 0 } });
    provider = new FileConfigProvider(file);
    expect(() => provider!.load()).toThrow(StartupError);
    expect(() => provider!.load()).toThrow(/limits\.maxTurnsPerRun: /);
  });

  it('rejects unknown keys', async () => {
    await write({ repo: { path: '/r' }, githubToken: 'ghp_x' });
    provider = new FileConfigProvider(file);
    expect(() => provider!.load()).toThrow(/githubToken/);
  });

  it('rejects invalid JSON and a missing file', async () => {
    await write('{ nope');
    provider = new FileConfigProvider(file);
    expect(() => provider!.load()).toThrow(/invalid JSON/);
    const missing = new FileConfigProvider(join(dir, 'absent.json'));
    expect(() => missing.load()).toThrow(/not found/);
  });

  it('current() before load() fails loudly', () => {
    expect(() => new FileConfigProvider(file).current()).toThrow();
  });
});

describe('FileConfigProvider hot reload', () => {
  it('swaps the config on a valid edit, leaving earlier snapshots untouched', async () => {
    await write({ repo: { path: '/r' } });
    provider = new FileConfigProvider(file, { debounceMs: 20 });
    const first = provider.load();
    const seen: JarvisConfig[] = [];
    provider.onChange((c) => seen.push(c));

    await write({ repo: { path: '/r' }, limits: { dailyBudgetUsd: 5 } });
    await until(() => seen.length > 0);

    expect(provider.current().limits.dailyBudgetUsd).toBe(5);
    expect(first.limits.dailyBudgetUsd).toBe(20);
    expect(seen.at(-1)).toBe(provider.current());
    expect(provider.lastError()).toBeNull();
  });

  it('keeps the last good config on an invalid edit and records the error', async () => {
    await write({ repo: { path: '/r' } });
    provider = new FileConfigProvider(file, { debounceMs: 20 });
    const first = provider.load();
    let changes = 0;
    provider.onChange(() => changes++);

    await write({ repo: { path: '/r' }, limits: { stallMinutes: -1 } });
    await until(() => provider!.lastError() !== null);

    expect(provider.current()).toBe(first);
    expect(provider.lastError()).toMatch(/limits\.stallMinutes/);
    expect(changes).toBe(0);

    await write({ repo: { path: '/r' }, limits: { stallMinutes: 7 } });
    await until(() => provider!.lastError() === null);
    expect(provider.current().limits.stallMinutes).toBe(7);
  });

  it('stops reacting after close()', async () => {
    await write({ repo: { path: '/r' } });
    provider = new FileConfigProvider(file, { debounceMs: 10 });
    provider.load();
    provider.close();
    await write({ repo: { path: '/other' } });
    await new Promise((r) => setTimeout(r, 100));
    expect(provider.current().repo.path).toBe('/r');
  });
});

describe('FileConfigProvider.update', () => {
  it('merges the patch into the raw file, keeping sibling fields, and writes it back', async () => {
    await write({ repo: { path: '/r' }, limits: { dailyBudgetUsd: 5 } });
    provider = new FileConfigProvider(file);
    provider.load();

    const config = await provider.update({ limits: { stallMinutes: 1 } });

    expect(config.limits.stallMinutes).toBe(1);
    expect(config.limits.dailyBudgetUsd).toBe(5);
    expect(provider.current().limits.stallMinutes).toBe(1);

    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    expect(onDisk.limits).toEqual({ stallMinutes: 1, dailyBudgetUsd: 5 });
  });

  it('rejects a merge that fails validation, writing nothing', async () => {
    await write({ repo: { path: '/r' } });
    provider = new FileConfigProvider(file);
    provider.load();

    await expect(provider.update({ limits: { stallMinutes: -1 } })).rejects.toThrow(
      /limits\.stallMinutes/,
    );
    expect(provider.current().limits.stallMinutes).toBe(10);
  });
});
