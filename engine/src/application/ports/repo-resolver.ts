/** ADR-0012: resolves a task's requested `owner/name` against the allow-list / owner-account rule. */
export interface RepoResolver {
  /** Rejects (any `Error`, message meant for the model/owner) when the repo is not allowed. */
  resolve(ownerSlashName: string): Promise<{ owner: string; name: string }>;
}
