import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  describe('readImage (ADR-0014)', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    beforeEach(() => {
      mkdirSync(join(store.dirFor('T-1'), 'screenshots'), { recursive: true });
      writeFileSync(join(store.dirFor('T-1'), 'screenshots', '001-card.png'), png);
    });

    it('reads a screenshot with its base name, type and size', async () => {
      const blob = await store.readImage('T-1', 'screenshots/001-card.png');
      expect(blob).toMatchObject({
        name: '001-card.png',
        contentType: 'image/png',
        sizeBytes: png.byteLength,
      });
      expect(Buffer.from(blob.bytes)).toEqual(png);
    });

    it('refuses a path that leaves the task folder (AC-16)', async () => {
      writeFileSync(join(root, 'outside.png'), png);
      for (const path of ['../outside.png', '../../outside.png', '/etc/hosts.png']) {
        await expect(store.readImage('T-1', path)).rejects.toThrow(/outside/);
      }
    });

    it('refuses a symlink that points out of the task folder (AC-16)', async () => {
      writeFileSync(join(root, 'outside.png'), png);
      symlinkSync(join(root, 'outside.png'), join(store.dirFor('T-1'), 'link.png'));

      await expect(store.readImage('T-1', 'link.png')).rejects.toThrow(/outside/);
    });

    it('refuses anything that is not an image (AC-17)', async () => {
      writeFileSync(join(store.dirFor('T-1'), 'spec.md'), '# Spec');
      await expect(store.readImage('T-1', 'spec.md')).rejects.toThrow(/not an image/);
    });

    it('reports a missing screenshot as not found', async () => {
      await expect(store.readImage('T-1', 'screenshots/nope.png')).rejects.toThrow(/not found/);
    });
  });

  it('rejects unknown names and traversal attempts', async () => {
    writeFileSync(join(root, 'secret.md'), 's');
    for (const name of ['notes.md', '../secret.md', '../../etc/passwd', 'spec.md/..']) {
      await expect(store.read('T-1', name as ArtifactName)).rejects.toThrow();
    }
    expect(() => store.dirFor('../tasks')).toThrow(/Invalid task id/);
  });
});
