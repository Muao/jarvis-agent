import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileCapabilityCatalog } from './file-capability-catalog.js';
import { FileOwnerPluginStore } from './file-owner-plugin-store.js';

const REPO_AGENT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../agent');

describe('FileCapabilityCatalog', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jarvis-catalog-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };

  const catalog = (allowed: string[] = []) =>
    new FileCapabilityCatalog({
      agentDir: REPO_AGENT,
      ownerPluginDir: join(root, 'plugin'),
      reposRoot: join(root, 'repos'),
      allowedRepos: () => allowed,
      mcpServers: async () => [],
    });

  it('lists the built-in plugin: model and tools for agents, none for skills', async () => {
    const { skills, agents } = await catalog().list();

    const reviewer = agents.find((a) => a.name === 'reviewer');
    expect(reviewer).toMatchObject({ source: 'builtin', model: 'sonnet', editable: false });
    expect(reviewer?.tools).toContain('Read');
    expect(reviewer?.description).not.toBe('');
    const sdd = skills.find((s) => s.name === 'sdd-flow');
    expect(sdd).toMatchObject({ source: 'builtin', editable: false });
    expect(sdd?.tools).toBeUndefined();
  });

  it('lists the owner’s items as editable', async () => {
    const owner = new FileOwnerPluginStore({
      pluginDir: join(root, 'plugin'),
      backupsDir: join(root, 'backups'),
    });
    await owner.put('skills', 'mine', { description: 'My skill', body: '#' });
    await owner.put('agents', 'helper', { description: 'Helps', body: '#', model: 'haiku' });

    const { skills, agents } = await catalog().list();

    expect(skills.find((s) => s.name === 'mine')).toEqual({
      name: 'mine',
      description: 'My skill',
      source: 'owner',
      editable: true,
    });
    expect(agents.find((a) => a.name === 'helper')).toMatchObject({
      source: 'owner',
      model: 'haiku',
      editable: true,
    });
  });

  it('lists allow-listed repos that are cloned and skips the others silently', async () => {
    const repo = join(root, 'repos', 'acme', 'blog', '.claude');
    write(
      join(repo, 'agents', 'qa.md'),
      '---\nname: qa\ndescription: Tests it\ntools: Read\n---\nx',
    );
    write(
      join(repo, 'skills', 'deploy', 'SKILL.md'),
      '---\nname: deploy\ndescription: Ships\n---\nx',
    );

    const { skills, agents } = await catalog(['acme/blog', 'acme/not-cloned', '../evil/x']).list();

    expect(agents.find((a) => a.name === 'qa')).toMatchObject({
      source: 'repo',
      repo: 'acme/blog',
      editable: false,
      tools: ['Read'],
    });
    expect(skills.find((s) => s.name === 'deploy')).toMatchObject({
      source: 'repo',
      repo: 'acme/blog',
    });
    expect(agents.filter((a) => a.source === 'repo')).toHaveLength(1);
  });

  it('falls back to the file name when the frontmatter is missing', async () => {
    write(join(root, 'repos', 'acme', 'blog', '.claude', 'agents', 'bare.md'), '# no frontmatter');

    const { agents } = await catalog(['acme/blog']).list();

    expect(agents.find((a) => a.repo === 'acme/blog')).toMatchObject({
      name: 'bare',
      description: '',
    });
  });

  it('does not list an agents/README.md as a subagent', async () => {
    write(join(root, 'repos', 'acme', 'blog', '.claude', 'agents', 'README.md'), '# Agents');

    const { agents } = await catalog(['acme/blog']).list();

    expect(agents.map((a) => a.name)).not.toContain('README');
  });
});
