import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed (exit ${exitCode ?? 'unknown'}): ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

export interface RunGitOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** The child's whole environment. Absent: inherited from the engine, as before. */
  readonly env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** The only place that spawns `git`: no shell, argument array, bounded by a timeout. */
export function runGit(args: readonly string[], options: RunGitOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        ...(options.env === undefined ? {} : { env: options.env }),
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === 'number' ? error.code : null;
          reject(new GitError(args, code, stderr || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
