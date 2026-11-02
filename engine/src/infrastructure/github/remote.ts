export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

const PATTERNS = [
  /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
  /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
  /^https?:\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
];

/** `git@github.com:o/r.git`, `https://github.com/o/r(.git)` → `{ owner, repo }`; null when not GitHub. */
export function parseRemote(url: string): RepoRef | null {
  const trimmed = url.trim();
  for (const pattern of PATTERNS) {
    const m = pattern.exec(trimmed);
    if (m?.[1] && m[2]) return { owner: m[1], repo: m[2] };
  }
  return null;
}
