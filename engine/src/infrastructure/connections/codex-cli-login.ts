import type { Exec } from './exec.js';

const LOGIN_TIMEOUT_MS = 8000;

export type CodexCliLogin = 'chatgpt' | 'chatgpt-required' | 'unavailable';

/** Checks the active login without starting a model run or reading credentials. */
export async function checkCodexCliLogin(binary: string, exec: Exec): Promise<CodexCliLogin> {
  const result = await exec(binary, ['login', 'status'], {
    timeoutMs: LOGIN_TIMEOUT_MS,
  }).catch(() => null);

  if (result === null) return 'unavailable';

  const usesChatGpt = [result.stdout, result.stderr ?? '']
    .join('\n')
    .split(/\r?\n/)
    .some((line) => {
      return line.trim() === 'Logged in using ChatGPT';
    });
  return result.exitCode === 0 && usesChatGpt ? 'chatgpt' : 'chatgpt-required';
}
