import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactName } from '@jarvis/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileArtifactStore } from './file-artifact-store.js';

describe('FileArtifactStore', () => {
  let root: string;
  let store: FileArtifactStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jarvis-art-'));
    store = new FileArtifactStore(join(root, 'tasks'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('dirFor creates the task folder', () => {
    const dir = store.dirFor('T-1');
    expect(dir).toBe(join(root, 'tasks', 'T-1'));
    expect(existsSync(dir)).toBe(true);
  });

  it('reads an existing artifact with content and updatedAt', async () => {
    writeFileSync(join(store.dirFor('T-1'), 'spec.md'), '# Spec');
    const file = await store.read('T-1', 'spec.md');
    expect(file).toMatchObject({ name: 'spec.md', exists: true, content: '# Spec' });
    expect(Number.isNaN(Date.parse(file.updatedAt ?? ''))).toBe(false);
  });

  it('reports a missing artifact as not written yet', async () => {
    expect(await store.read('T-1', 'plan.md')).toEqual({
      name: 'plan.md',
      exists: false,
      content: null,
      updatedAt: null,
    });
  });

  it('lists all five names with exists', async () => {
    writeFileSync(join(store.dirFor('T-1'), 'context.md'), 'c');
    const all = await store.list('T-1');
    expect(all.map((a) => a.name)).toEqual([
      'context.md',
      'spec.md',
      'plan.md',
      'tasks.md',
      'result.md',
    ]);
    expect(all.filter((a) => a.exists).map((a) => a.name)).toEqual(['context.md']);
  });

  it('rejects unknown names and traversal attempts', async () => {
    writeFileSync(join(root, 'secret.md'), 's');
    for (const name of ['notes.md', '../secret.md', '../../etc/passwd', 'spec.md/..']) {
      await expect(store.read('T-1', name as ArtifactName)).rejects.toThrow();
    }
    expect(() => store.dirFor('../tasks')).toThrow(/Invalid task id/);
  });
});
