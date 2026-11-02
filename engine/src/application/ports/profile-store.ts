/** The owner's `USER.md` (PRF-02). Read fresh for every run so a change applies without a restart (PRF-03). */
export interface ProfileStore {
  /** The preferences text, or null when the owner has none. */
  userPreferences(): Promise<string | null>;
}
