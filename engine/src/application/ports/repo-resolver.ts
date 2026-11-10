/** ADR-0012: resolves a task's requested `owner/name` against the allow-list / owner-account rule. */
export interface RepoResolver {
  /** Rejects (any `Error`, message meant for the model/owner) when the repo is not allowed. */
  resolve(ownerSlashName: string): Promise<{ owner: string; name: string }>;
  /**
   * ADR-0021: the configured default repository (`repo.path`'s remote), which a task without a
   * `targetRepo` works in; null when that remote is not a GitHub repository.
   */
  defaultRepo(): { owner: string; name: string } | null;
}
