import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { GitWorktreeManager } from './git-worktree-manager.js';

/** Test scaffolding for the publisher: a clone with a bare `origin`, and a worktree for T-1. */

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

export interface Fixture {
  readonly root: string;
  /** The clone the worktrees hang off — the repository the worker can write the config of. */
  readonly repo: string;
  readonly bare: string;
  readonly worktreesDir: string;
  readonly worktree: string;
  commit(file: string, content?: string, message?: string): string;
  cleanup(): void;
}

export async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-publish-'));
  const repo = join(root, 'repo');
  const bare = join(root, 'origin.git');
  const worktreesDir = join(root, 'worktrees');

  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  execFileSync('git', ['clone', '-q', '--bare', repo, bare]);
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'fetch', '-q', 'origin');

  const manager = new GitWorktreeManager({
    repoPath: repo,
    remote: 'origin',
    baseBranch: 'main',
    worktreesDir,
  });
  const { path: worktree } = await manager.create('T-1');

  return {
    root,
    repo,
    bare,
    worktreesDir,
    worktree,
    commit(file, content = file, message = `add ${file}`) {
      mkdirSync(dirname(join(worktree, file)), { recursive: true });
      writeFileSync(join(worktree, file), content);
      git(worktree, 'add', file);
      git(worktree, 'commit', '-qm', message);
      return git(worktree, 'rev-parse', 'HEAD');
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
