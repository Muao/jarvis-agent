/** What a `mutate` callback hands back: the whole new file text, and what the caller wants to know. */
export interface ProfileEdit<T> {
  readonly content: string;
  readonly result: T;
}

export interface ProfileMutateOptions {
  /** Copy the current file to the backups directory first (before `forget` and `merge_insights`). */
  readonly backup?: boolean;
}

/** The owner's `USER.md` (PRF-02). Read fresh for every run so a change applies without a restart (PRF-03). */
export interface ProfileStore {
  /** The preferences text, or null when the owner has none. */
  userPreferences(): Promise<string | null>;
  /** The file as it is on disk now; an empty string when it does not exist yet. */
  read(): Promise<string>;
  /**
   * ADR-0021: reads the file fresh, hands its text to `fn` (a pure function), and writes the
   * returned `content` back atomically. Calls run one at a time, so no edit is lost to another.
   * `fn` throwing leaves the file untouched and rejects the call; returning the text unchanged
   * writes nothing. Resolves with `result`.
   */
  mutate<T>(fn: (current: string) => ProfileEdit<T>, options?: ProfileMutateOptions): Promise<T>;
}
