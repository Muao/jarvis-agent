import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Worktree, WorktreeManager } from '../../application/ports/worktree-manager.js';
import type { AllowedRepoResolver } from './allowed-repo-resolver.js';
import { cloneOnDemand, type CloneOnDemandOptions } from './clone-on-demand.js';
import { GitError, runGit } from './run-git.js';
import type { RepoRef } from '../github/remote.js';

export interface GitWorktreeManagerOptions {
  readonly repoPath: string;
  readonly remote: string;
  readonly baseBranch: string;
  readonly worktreesDir: string;
  /** ADR-0012: resolves and clones a task's target repo when `create` is given one. */
  readonly targetRepos?: {
    readonly resolver: AllowedRepoResolver;
    readonly reposRoot: string;
    readonly token: string;
    /** Overrides the clone URL; defaults to GitHub over HTTPS with `token` (tests only). */
    readonly cloneUrl?: (ref: RepoRef, token: string) => string;
  };
}

interface SourceRepo {
  readonly repoPath: string;
  readonly remote: string;
  readonly baseBranch: string;
}

const TASK_ID = /^T-\d+$/;

/** Where the engine leaves what it precomputed for a `ui_check` worker, inside its worktree. */
const CHECK_DIR = '.jarvis';

/** DSP-01: one branch `jarvis/<taskId>` and one worktree per task. Never deletes anything (SEC-02, DSP-06). */
export class GitWorktreeManager implements WorktreeManager {
  constructor(private readonly options: GitWorktreeManagerOptions) {}

  async create(
    taskId: string,
    targetRepo?: { owner: string; name: string } | null,
  ): Promise<Worktree> {
    if (!TASK_ID.test(taskId)) {
      throw new Error(`Invalid task id: ${JSON.stringify(taskId)}`);
    }
    const { worktreesDir } = this.options;
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
    const source = await this.resolveSourceRepo(targetRepo ?? null);

    if (await this.branchExists(branch, source)) {
      await runGit(['worktree', 'add', path, branch], { cwd: source.repoPath });
      return { branch, path };
    }

    const base = await this.resolveBase(source);
    await runGit(['worktree', 'add', '-b', branch, path, base], { cwd: source.repoPath });
    return { branch, path };
  }

  /** ADR-0018: stand a worktree on an existing PR's head, on a `jarvis-check/*` branch. */
  async createForPullRequest(
    taskId: string,
    targetRepo: { owner: string; name: string } | null,
    prNumber: number,
  ): Promise<Worktree> {
    if (!TASK_ID.test(taskId)) {
      throw new Error(`Invalid task id: ${JSON.stringify(taskId)}`);
    }
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error(`Invalid pull request number: ${JSON.stringify(prNumber)}`);
    }
    const { worktreesDir } = this.options;
    const branch = `jarvis-check/${taskId}`;
    const path = join(worktreesDir, taskId);

    if (existsSync(path)) {
      const current = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path })).trim();
      if (current !== branch) {
        throw new Error(`Worktree ${path} exists but is on "${current}", expected "${branch}"`);
      }
      // A worktree from before the engine precomputed the diff gets it on first reuse.
      if (!existsSync(join(path, CHECK_DIR, 'diff.patch'))) {
        await this.writeDiffForCheck(path, await this.resolveSourceRepo(targetRepo));
      }
      return { branch, path };
    }

    await mkdir(worktreesDir, { recursive: true });
    const source = await this.resolveSourceRepo(targetRepo);

    // A branch left by an earlier attempt at the same task is the same PR's head: reuse it rather
    // than force-fetching over it.
    if (!(await this.branchExists(branch, source))) {
      await runGit(['fetch', source.remote, `pull/${prNumber}/head:${branch}`], {
        cwd: source.repoPath,
      });
    }
    await runGit(['worktree', 'add', path, branch], { cwd: source.repoPath });
    await this.writeDiffForCheck(path, source);
    return { branch, path };
  }

  /** ADR-0021: a cited file counts only if it is a regular file inside the worktree. */
  async hasFile(worktreePath: string, relativePath: string): Promise<boolean> {
    const root = resolve(worktreePath);
    const target = resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${sep}`)) return false;
    try {
      return (await stat(target)).isFile();
    } catch {
      return false;
    }
  }

  /**
   * ADR-0018: a `ui_check` worker has no shell, so the engine computes the diff it will read —
   * `.jarvis/changed-files.txt` and `.jarvis/diff.patch` at the worktree root. `--output` writes
   * straight to the file, so a large pull request never hits a stdout buffer, and the merge-base
   * form (`base...HEAD`) shows the pull request's own changes, not the base branch's drift.
   */
  private async writeDiffForCheck(worktreePath: string, source: SourceRepo): Promise<void> {
    const base = await this.resolveBase(source);
    const dir = join(worktreePath, CHECK_DIR);
    await mkdir(dir, { recursive: true });
    await runGit(
      ['diff', '--name-status', `${base}...HEAD`, `--output=${join(dir, 'changed-files.txt')}`],
      { cwd: worktreePath },
    );
    await runGit(['diff', `${base}...HEAD`, `--output=${join(dir, 'diff.patch')}`], {
      cwd: worktreePath,
    });
  }

  /** The configured default repo, or a target repo resolved and cloned on demand (ADR-0012). */
  private async resolveSourceRepo(
    targetRepo: { owner: string; name: string } | null,
  ): Promise<SourceRepo> {
    const { repoPath, remote, baseBranch } = this.options;
    if (targetRepo === null) return { repoPath, remote, baseBranch };

    if (this.options.targetRepos === undefined) {
      throw new Error(
        `GitWorktreeManager: task targets "${targetRepo.owner}/${targetRepo.name}" but clone-on-demand is not configured`,
      );
    }
    const { resolver, reposRoot, token, cloneUrl } = this.options.targetRepos;
    const ref = await resolver.resolve(`${targetRepo.owner}/${targetRepo.name}`);
    const cloneOptions: CloneOnDemandOptions = {
      reposRoot,
      token,
      ...(cloneUrl === undefined ? {} : { cloneUrl }),
    };
    const clonedPath = await cloneOnDemand(ref, cloneOptions);
    return { repoPath: clonedPath, remote: 'origin', baseBranch };
  }

  private async branchExists(branch: string, source: SourceRepo): Promise<boolean> {
    try {
      await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
        cwd: source.repoPath,
      });
      return true;
    } catch (error) {
      if (error instanceof GitError && error.exitCode === 1) return false;
      throw error;
    }
  }

  /** Fetches the base from the remote and returns the ref to branch from. */
  private async resolveBase(source: SourceRepo): Promise<string> {
    const { repoPath, remote, baseBranch } = source;
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
