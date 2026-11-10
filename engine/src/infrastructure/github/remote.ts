export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

const PATTERNS = [
  /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
  /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
  /^https?:\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
];

const OWNER_SLASH_NAME = /^([^/\s]+)\/([^/\s]+)$/;

/**
 * The repository the GitHub adapter is built for: `repo.path`'s remote when it is a GitHub one,
 * otherwise the first `repos.allow` entry (ADR-0012). Every per-task call passes its own repo, so
 * this only decides whether GitHub is configured at all; a `repo.path` that is a local sandbox
 * without a remote must not switch GitHub off for the allow-listed repositories.
 */
export function defaultGitHubRepo(
  remoteUrl: string | null,
  allow: readonly string[],
): RepoRef | null {
  const fromRemote = remoteUrl === null ? null : parseRemote(remoteUrl);
  if (fromRemote !== null) return fromRemote;
  const m = OWNER_SLASH_NAME.exec(allow[0]?.trim() ?? '');
  return m?.[1] && m[2] ? { owner: m[1], repo: m[2] } : null;
}

/** `git@github.com:o/r.git`, `https://github.com/o/r(.git)` → `{ owner, repo }`; null when not GitHub. */
export function parseRemote(url: string): RepoRef | null {
  const trimmed = url.trim();
  for (const pattern of PATTERNS) {
    const m = pattern.exec(trimmed);
    if (m?.[1] && m[2]) return { owner: m[1], repo: m[2] };
  }
  return null;
}
