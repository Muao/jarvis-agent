import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BranchPublisher,
  BranchStatus,
  PushResult,
} from '../../application/ports/branch-publisher.js';
import type { RepoTarget } from '../../application/ports/code-host.js';
import { createRedactor } from '../config/redact.js';
import { runGit } from './run-git.js';

type RunGit = typeof runGit;

export interface GitBranchPublisherOptions {
  /** The engine's `GITHUB_TOKEN`. It lives in the push child's environment and nowhere else (ADR-0022). */
  readonly token: string;
  /** Where the task worktrees are: `<worktreesDir>/<taskId>`. */
  readonly worktreesDir: string;
  readonly baseBranch: string;
  readonly remote: string;
  /** Where `PATH` and `HOME` come from; the composition root reads them (ADR-0015). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Replaces the GitHub URL. **Tests only**: a `file://` bare repository. The credential header is
   * then simply never sent, because it is scoped to `https://github.com/`.
   */
  readonly remoteUrl?: (repo: RepoTarget) => string;
  /** Injectable so a test can record the argument lists and environments. */
  readonly runGit?: RunGit;
  readonly pushTimeoutMs?: number;
}

const TASK_ID = /^T-\d+$/;
const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const PUSH_TIMEOUT_MS = 5 * 60_000;

/** Failures that are the host's answer rather than the network's. Anything else is `unreachable`. */
const REFUSED =
  /\brejected\b|non-fast-forward|fetch first|stale info|protected branch|denied|Authentication failed|returned error: (?:401|403|404)|Permission to .* denied|Repository not found|hook declined/i;

/**
 * ADR-0022. The engine's git: reads a task's worktree and pushes its commit with the bot token.
 *
 * The worker can write the clone's config, hooks and remote (its `Bash` is bare), so nothing here
 * trusts them:
 *
 * - **Reading** (`headSha`, `status`) runs with `core.fsmonitor`, hooks and the pager off, no
 *   `diff.external`/textconv, the git environment narrowed, and never touches the network.
 * - **Pushing** does not run in the worktree or the clone at all. It runs in a throwaway bare
 *   repository the engine creates with an empty template, whose only link to the clone is an
 *   `objects/info/alternates` line. Its config is the engine's, so a `core.hooksPath`,
 *   `credential.helper`, `core.askPass`, `http.proxy`, `http.sslVerify`, `url.*.insteadOf` or any
 *   other key the worker wrote is not read. The ADR's explicit flags are passed as well, as a
 *   second layer.
 * - The URL is built here from the task's repo, never from `remote get-url`; the refspec is
 *   `<sha>:refs/heads/jarvis/<taskId>`, no force, no tags; the token travels as an
 *   `http.https://github.com/.extraheader` entry in `GIT_CONFIG_*` environment variables, so it is
 *   in no argv and in no file.
 */
export class GitBranchPublisher implements BranchPublisher {
  private readonly git: RunGit;
  private readonly redact: (text: string) => string;

  constructor(private readonly options: GitBranchPublisherOptions) {
    this.git = options.runGit ?? runGit;
    this.redact = createRedactor([
      options.token,
      basicCredential(options.token),
      Buffer.from(basicCredential(options.token), 'utf8').toString('base64'),
    ]);
  }

  async headSha(taskId: string): Promise<string> {
    return (await this.read(taskId, ['rev-parse', 'HEAD'])).trim();
  }

  async status(taskId: string): Promise<BranchStatus> {
    const cwd = this.worktreeOf(taskId);
    const base = await this.baseRef(cwd);
    const [porcelain, ahead, changed] = await Promise.all([
      this.read(taskId, [
        'status',
        '--porcelain=v1',
        '-z',
        '--no-renames',
        '--untracked-files=all',
      ]),
      this.read(taskId, ['rev-list', '--count', `${base}..HEAD`]),
      this.read(taskId, [
        'diff',
        '--name-only',
        '-z',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        `${base}...HEAD`,
        '--',
      ]),
    ]);
    return {
      dirtyFiles: porcelain
        .split('\0')
        .filter((entry) => entry.length > 3)
        .map((entry) => entry.slice(3)),
      commitsAhead: Number.parseInt(ahead.trim(), 10) || 0,
      changedFiles: changed.split('\0').filter((path) => path !== ''),
    };
  }

  async push(input: {
    readonly taskId: string;
    readonly repo: RepoTarget;
    readonly sha: string;
  }): Promise<PushResult> {
    const { taskId, repo, sha } = input;
    if (!TASK_ID.test(taskId)) throw new Error(`Invalid task id: ${JSON.stringify(taskId)}`);
    if (!SHA.test(sha)) throw new Error(`Invalid commit id: ${JSON.stringify(sha)}`);
    if (!isSegment(repo.owner) || !isSegment(repo.name)) {
      throw new Error(`Invalid repository: ${JSON.stringify(`${repo.owner}/${repo.name}`)}`);
    }

    let scratch: string | null = null;
    try {
      const objects = (
        await this.read(taskId, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'])
      ).trim();
      scratch = await mkdtemp(join(tmpdir(), 'jarvis-push-'));
      const gitDir = join(scratch, 'git');
      await this.git(['init', '--bare', '--quiet', '--template=', gitDir], {
        cwd: scratch,
        env: this.baseEnv(),
      });
      await mkdir(join(gitDir, 'objects', 'info'), { recursive: true });
      await writeFile(join(gitDir, 'objects', 'info', 'alternates'), `${objects}\n`);

      const url = this.options.remoteUrl?.(repo) ?? githubUrl(repo);
      await this.git(
        [
          ...HARDENING,
          'push',
          '--no-verify',
          '--no-follow-tags',
          url,
          `${sha}:refs/heads/jarvis/${taskId}`,
        ],
        {
          cwd: gitDir,
          env: this.pushEnv(url),
          timeoutMs: this.options.pushTimeoutMs ?? PUSH_TIMEOUT_MS,
        },
      );
      return { ok: true };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const detail = this.redact(text).replaceAll(scratch ?? '\0', '<scratch>');
      return {
        ok: false,
        reason: REFUSED.test(detail) ? 'rejected' : 'unreachable',
        detail: detail.slice(0, 2000),
      };
    } finally {
      if (scratch !== null) await rm(scratch, { recursive: true, force: true });
    }
  }

  async baseFile(input: {
    readonly taskId: string;
    readonly repo: RepoTarget;
    readonly path: string;
  }): Promise<string | null> {
    const { taskId, repo, path } = input;
    if (!TASK_ID.test(taskId)) throw new Error(`Invalid task id: ${JSON.stringify(taskId)}`);
    if (!isSafePath(path)) return null;
    if (!isSegment(repo.owner) || !isSegment(repo.name)) return null;

    let scratch: string | null = null;
    try {
      scratch = await mkdtemp(join(tmpdir(), 'jarvis-base-'));
      const gitDir = join(scratch, 'git');
      await this.git(['init', '--bare', '--quiet', '--template=', gitDir], {
        cwd: scratch,
        env: this.baseEnv(),
      });
      const url = this.options.remoteUrl?.(repo) ?? githubUrl(repo);
      await this.git(
        [...HARDENING, 'fetch', '--quiet', '--depth=1', '--no-tags', url, this.options.baseBranch],
        {
          cwd: gitDir,
          env: this.pushEnv(url),
          timeoutMs: this.options.pushTimeoutMs ?? PUSH_TIMEOUT_MS,
        },
      );
      return await this.git([...READ_ONLY, 'show', `FETCH_HEAD:${path}`], {
        cwd: gitDir,
        env: this.baseEnv(),
      });
    } catch {
      return null;
    } finally {
      if (scratch !== null) await rm(scratch, { recursive: true, force: true });
    }
  }

  async mergeBase(taskId: string): Promise<string> {
    const base = await this.baseRef(this.worktreeOf(taskId));
    return (await this.read(taskId, ['merge-base', 'HEAD', base])).trim();
  }

  async onBase<T>(taskId: string, sha: string, run: () => Promise<T>): Promise<T> {
    if (!SHA.test(sha)) throw new Error(`Invalid commit id: ${JSON.stringify(sha)}`);
    const dirty = await this.read(taskId, ['status', '--porcelain=v1', '--untracked-files=no']);
    if (dirty.trim() !== '') throw new Error('The worktree has uncommitted changes');
    await this.read(taskId, ['checkout', '--detach', '--quiet', sha]);
    try {
      return await run();
    } finally {
      // The tree was clean before the switch: whatever is changed now, the base run changed.
      await this.read(taskId, ['checkout', '--force', '--quiet', `jarvis/${taskId}`]);
    }
  }

  private worktreeOf(taskId: string): string {
    if (!TASK_ID.test(taskId)) throw new Error(`Invalid task id: ${JSON.stringify(taskId)}`);
    return join(this.options.worktreesDir, taskId);
  }

  /** A read in the worktree: nothing in the repository's config gets to run. */
  private async read(taskId: string, args: readonly string[]): Promise<string> {
    try {
      return await this.git([...READ_ONLY, ...args], {
        cwd: this.worktreeOf(taskId),
        env: this.baseEnv(),
      });
    } catch (error) {
      // No `cause`: the original error carries the unredacted text, and a cause gets logged.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(this.redact(error instanceof Error ? error.message : String(error)));
    }
  }

  /**
   * The base as already fetched when the worktree was made — `<remote>/<base>` if that ref exists,
   * the local branch otherwise (a repo with no remote). No fetch: a read must not use the network.
   */
  private async baseRef(cwd: string): Promise<string> {
    const { remote, baseBranch } = this.options;
    const tracking = `refs/remotes/${remote}/${baseBranch}`;
    try {
      await this.git([...READ_ONLY, 'rev-parse', '--verify', '--quiet', tracking], {
        cwd,
        env: this.baseEnv(),
      });
      return `${remote}/${baseBranch}`;
    } catch {
      return baseBranch;
    }
  }

  private baseEnv(): NodeJS.ProcessEnv {
    const env: Record<string, string> = {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    };
    for (const name of ['PATH', 'HOME'] as const) {
      const value = this.options.env[name];
      if (value !== undefined) env[name] = value;
    }
    return env;
  }

  /** The credential: a header scoped to `https://github.com/`, in the child's environment only. */
  private pushEnv(url: string): NodeJS.ProcessEnv {
    return {
      ...this.baseEnv(),
      // `https` for GitHub; whatever scheme the tests-only override uses (`file`, `http`) otherwise.
      GIT_ALLOW_PROTOCOL: new URL(url).protocol.slice(0, -1),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(basicCredential(this.options.token), 'utf8').toString('base64')}`,
    };
  }
}

/** ADR-0022: neutralised on every command that runs in or against a repository the worker can write. */
const READ_ONLY = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.pager=cat',
  '-c',
  'core.editor=true',
  '-c',
  'diff.external=',
] as const;

const HARDENING = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'credential.helper=',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.sshCommand=false',
  '-c',
  'core.askPass=',
  '-c',
  'http.proxy=',
  '-c',
  'http.sslVerify=true',
  '-c',
  'http.followRedirects=false',
] as const;

const basicCredential = (token: string): string => `x-access-token:${token}`;
const githubUrl = (repo: RepoTarget): string => `https://github.com/${repo.owner}/${repo.name}.git`;
const isSafePath = (path: string): boolean =>
  path !== '' &&
  !path.startsWith('/') &&
  !path.includes('\0') &&
  !path.split('/').some((part) => part === '..');
const isSegment = (value: string): boolean =>
  SEGMENT.test(value) && value !== '.' && value !== '..';
