import type { RepoRef } from '../github/remote.js';
import { parseRemote } from '../github/remote.js';
import { runGit } from './run-git.js';

/** Thrown when a requested `owner/name` is neither allow-listed nor owned by the authenticated account. */
export class RepoNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RepoNotAllowedError';
  }
}

export interface RepoAllowlistConfig {
  readonly allow: readonly string[];
  readonly allowOwnerRepos: boolean;
}

/** The subset of the GitHub adapter the resolver needs (ADR-0009's `CodeHost.botLogin`). */
export interface GitHubAccountLookup {
  botLogin(): Promise<string>;
}

const OWNER_SLASH_NAME = /^([^/\s]+)\/([^/\s]+)$/;

function parseOwnerSlashName(value: string): RepoRef {
  const match = OWNER_SLASH_NAME.exec(value.trim());
  if (!match) {
    throw new RepoNotAllowedError(`Invalid repo "${value}": expected "owner/name"`);
  }
  const [, owner, repo] = match;
  return { owner: owner!, repo: repo! };
}

function sameRepo(a: RepoRef, b: RepoRef): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

/**
 * Resolves `owner/name` against `repos.allow` / `repos.allowOwnerRepos` (ADR-0019). Never resolves
 * Jarvis's own repository, whichever way it is asked for.
 */
export class AllowedRepoResolver {
  constructor(
    private readonly config: RepoAllowlistConfig,
    private readonly account: GitHubAccountLookup,
    private readonly selfRepo: RepoRef | null,
  ) {}

  async resolve(ownerSlashName: string): Promise<RepoRef> {
    const ref = parseOwnerSlashName(ownerSlashName);

    if (this.selfRepo !== null && sameRepo(ref, this.selfRepo)) {
      throw new RepoNotAllowedError(
        `"${ownerSlashName}" is Jarvis's own repository and cannot be a task target`,
      );
    }

    if (this.config.allow.some((entry) => sameRepo(parseOwnerSlashName(entry), ref))) {
      return ref;
    }

    if (this.config.allowOwnerRepos) {
      const login = await this.account.botLogin();
      if (login.toLowerCase() === ref.owner.toLowerCase()) return ref;
    }

    throw new RepoNotAllowedError(
      `"${ownerSlashName}" is not in repos.allow and is not owned by the account GITHUB_TOKEN authenticates as`,
    );
  }
}

/** The owner/name of Jarvis's own working repository, for the resolver's self-repo check. Null when unknown. */
export async function selfRepoRef(repoPath: string, remote: string): Promise<RepoRef | null> {
  try {
    const url = (await runGit(['remote', 'get-url', remote], { cwd: repoPath })).trim();
    return parseRemote(url);
  } catch {
    return null;
  }
}
