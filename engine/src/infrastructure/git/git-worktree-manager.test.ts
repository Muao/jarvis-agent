import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitWorktreeManager } from './git-worktree-manager.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('GitWorktreeManager', () => {
  let root: string;
  let repo: string;
  let worktreesDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jarvis-git-'));
    repo = join(root, 'repo');
    worktreesDir = join(root, 'worktrees');
    execFileSync('git', ['init', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const manager = (remote = 'origin') =>
    new GitWorktreeManager({ repoPath: repo, remote, baseBranch: 'main', worktreesDir });

  it('creates branch jarvis/<id> and a worktree (no remote: local base)', async () => {
    const wt = await manager().create('T-1');
    expect(wt).toEqual({ branch: 'jarvis/T-1', path: join(worktreesDir, 'T-1') });
    expect(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('jarvis/T-1');
    expect(existsSync(join(wt.path, 'a.txt'))).toBe(true);
  });

  it('branches from the fetched remote base when a remote exists', async () => {
    const bare = join(root, 'origin.git');
    execFileSync('git', ['clone', '--bare', repo, bare]);
    git(repo, 'remote', 'add', 'origin', bare);
    const wt = await manager().create('T-2');
    expect(git(wt.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'));
  });

  it('is idempotent', async () => {
    const first = await manager().create('T-1');
    const second = await manager().create('T-1');
    expect(second).toEqual(first);
  });

  it('reuses an existing branch without a worktree', async () => {
    git(repo, 'branch', 'jarvis/T-3');
    const wt = await manager().create('T-3');
    expect(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('jarvis/T-3');
  });

  it('gives two tasks separate worktrees', async () => {
    const a = await manager().create('T-1');
    const b = await manager().create('T-2');
    expect(a.path).not.toBe(b.path);
    writeFileSync(join(a.path, 'a.txt'), 'changed');
    expect(git(b.path, 'status', '--porcelain')).toBe('');
  });

  it('rejects invalid task ids', async () => {
    for (const id of ['', 'T-', '../evil', 'T-1; rm -rf', 'x/T-1', '--force']) {
      await expect(manager().create(id)).rejects.toThrow(/Invalid task id/);
    }
  });

  it('fails when a configured remote cannot be fetched', async () => {
    git(repo, 'remote', 'add', 'origin', join(root, 'missing.git'));
    await expect(manager().create('T-4')).rejects.toThrow();
    expect(existsSync(join(worktreesDir, 'T-4'))).toBe(false);
  });
});
