/** The owner's `USER.md` (PRF-02). Read fresh for every run so a change applies without a restart (PRF-03). */
export interface ProfileStore {
  /** The preferences text, or null when the owner has none. */
  userPreferences(): Promise<string | null>;
  /**
   * ADR-0020: appends one bullet line under `## Learned` (creating the heading at end-of-file if
   * missing, or the file itself if it does not exist yet). Never touches any other byte of the file.
   */
  appendLearned(fact: string): Promise<void>;
}
