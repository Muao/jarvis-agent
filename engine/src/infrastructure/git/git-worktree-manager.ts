import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Worktree, WorktreeManager } from '../../application/ports/worktree-manager.js';
import { GitError, runGit } from './run-git.js';

export interface GitWorktreeManagerOptions {
  readonly repoPath: string;
  readonly remote: string;
  readonly baseBranch: string;
  readonly worktreesDir: string;
}

const TASK_ID = /^T-\d+$/;

/** DSP-01: one branch `jarvis/<taskId>` and one worktree per task. Never deletes anything (SEC-02, DSP-06). */
export class GitWorktreeManager implements WorktreeManager {
  constructor(private readonly options: GitWorktreeManagerOptions) {}

  async create(taskId: string): Promise<Worktree> {
    if (!TASK_ID.test(taskId)) {
      throw new Error(`Invalid task id: ${JSON.stringify(taskId)}`);
    }
    const { repoPath, worktreesDir } = this.options;
    const branch = `jarvis/${taskId}`;
    const path = join(worktreesDir, taskId);

    if (existsSync(path)) {
      const current = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path })).trim();
      if (current !== branch) {
        throw new Error(`Worktree ${path} exists but is on "${current}", expected "${branch}"`);
      }
      return { branch, path };
    }

    await mkdir(worktreesDir, { recursive: true });

    if (await this.branchExists(branch)) {
      await runGit(['worktree', 'add', path, branch], { cwd: repoPath });
      return { branch, path };
    }

    const base = await this.resolveBase();
    await runGit(['worktree', 'add', '-b', branch, path, base], { cwd: repoPath });
    return { branch, path };
  }

  private async branchExists(branch: string): Promise<boolean> {
    try {
      await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
        cwd: this.options.repoPath,
      });
      return true;
    } catch (error) {
      if (error instanceof GitError && error.exitCode === 1) return false;
      throw error;
    }
  }

  /** Fetches the base from the remote and returns the ref to branch from. */
  private async resolveBase(): Promise<string> {
    const { repoPath, remote, baseBranch } = this.options;
    try {
      await runGit(['fetch', remote, baseBranch], { cwd: repoPath });
      return `${remote}/${baseBranch}`;
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      // No such remote (e.g. a local-only repo in tests): fall back to the local base branch.
      const remotes = (await runGit(['remote'], { cwd: repoPath })).split('\n');
      if (remotes.includes(remote)) throw error;
      return baseBranch;
    }
  }
}
