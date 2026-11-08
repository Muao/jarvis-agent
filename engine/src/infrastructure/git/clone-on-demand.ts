import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepoRef } from '../github/remote.js';
import { GitError, runGit } from './run-git.js';

export interface CloneOnDemandOptions {
  /** `~/.jarvis/repos` (ADR-0012). */
  readonly reposRoot: string;
  /** The existing bot `GITHUB_TOKEN` (ADR-0007); no new credential. */
  readonly token: string;
  /** Builds the clone URL; defaults to GitHub over HTTPS. Overridable in tests only. */
  readonly cloneUrl?: (ref: RepoRef, token: string) => string;
}

const MASK = '[redacted]';

/** No credential in it: the token is supplied by `CREDENTIAL_HELPER` at the moment git asks (SEC-04). */
const defaultCloneUrl = (ref: RepoRef): string => `https://github.com/${ref.owner}/${ref.repo}.git`;

/**
 * SEC-04: a token baked into `remote.origin.url` is written to `.git/config` in plain text and
 * stays there for the life of the clone, where every later `git remote -v`, bug report or backup
 * carries it. This helper is stored instead; it holds no secret, and reads the token out of the
 * environment each time git asks for one. `GH_TOKEN` is what a worker's child gets (ADR-0003),
 * `GITHUB_TOKEN` what the engine's own process has.
 */
const CREDENTIAL_HELPER =
  '!f() { test "$1" = get && printf \'username=x-access-token\\npassword=%s\\n\' "${GH_TOKEN:-${GITHUB_TOKEN:-}}"; }; f';

const HELPER_KEY = 'credential.https://github.com.helper';

/** `https://user:token@host/...` — an http(s) remote carrying credentials. An SSH remote is left alone. */
const CREDENTIAL_IN_URL = /^https?:\/\/[^/]*@/;

/** Clones `owner/name` into `<reposRoot>/<owner>/<name>` on first use; reuses the tree otherwise (ADR-0012). */
export async function cloneOnDemand(ref: RepoRef, options: CloneOnDemandOptions): Promise<string> {
  const ownerDir = join(options.reposRoot, ref.owner);
  const path = join(ownerDir, ref.repo);
  if (existsSync(path)) {
    await stripStoredCredential(ref, path, options.token);
    return path;
  }

  await mkdir(ownerDir, { recursive: true });
  const url = (options.cloneUrl ?? defaultCloneUrl)(ref, options.token);
  try {
    // `-c` applies to this clone without being written into the new repo's config, so the helper
    // is installed deliberately below rather than inherited by accident.
    await runGit(['-c', `${HELPER_KEY}=${CREDENTIAL_HELPER}`, 'clone', url, path], {
      cwd: ownerDir,
    });
    await runGit(['config', '--local', HELPER_KEY, CREDENTIAL_HELPER], { cwd: path });
  } catch (error) {
    throw redact(error, options.token);
  }
  return path;
}

/**
 * Repairs a clone made by an earlier version, which baked the token into the remote URL: the URL is
 * rewritten clean and the helper installed. Runs on every reuse, so nothing has to be migrated by
 * hand, and does nothing to a clone that is already clean.
 */
async function stripStoredCredential(ref: RepoRef, path: string, token: string): Promise<void> {
  try {
    const stored = (
      await runGit(['config', '--local', '--get', 'remote.origin.url'], {
        cwd: path,
      })
    ).trim();
    if (!CREDENTIAL_IN_URL.test(stored)) return;
    await runGit(['remote', 'set-url', 'origin', defaultCloneUrl(ref)], { cwd: path });
    await runGit(['config', '--local', HELPER_KEY, CREDENTIAL_HELPER], { cwd: path });
  } catch (error) {
    // A repo we cannot read the remote of is still usable; never let the token into the message.
    throw redact(error, token);
  }
}

/** `GitError` embeds the clone URL (with the token) in its message; never let that reach a log (SEC-04). */
function redact(error: unknown, token: string): Error {
  if (!(error instanceof GitError))
    return error instanceof Error ? error : new Error(String(error));
  return new GitError(
    error.args.map((arg) => arg.split(token).join(MASK)),
    error.exitCode,
    error.stderr.split(token).join(MASK),
  );
}
