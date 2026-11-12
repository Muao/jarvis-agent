import { execFile } from 'node:child_process';

export interface ExecResult {
  readonly stdout: string;
  readonly stderr?: string;
  /** Exit code; a non-zero code is a result, not a failure to run. */
  readonly exitCode: number;
}

/** Runs a program and collects its output. Rejects when it cannot start or runs out of time. */
export type Exec = (
  file: string,
  args: readonly string[],
  options: { readonly timeoutMs: number },
) => Promise<ExecResult>;

/** The real `Exec`, with the given environment (the allow-listed child env, never the engine's own). */
export function execFileWith(env: Record<string, string>): Exec {
  return (file, args, { timeoutMs }) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        [...args],
        { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error === null) return resolve({ stdout, stderr, exitCode: 0 });
          if (error.killed)
            return reject(new Error(`${file} did not answer within ${timeoutMs} ms`));
          if (typeof error.code === 'number')
            return resolve({ stdout, stderr, exitCode: error.code });
          reject(error);
        },
      );
    });
}
