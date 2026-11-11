/** What Jarvis learned about the target repository from its own `AGENTS.md` (CON-04). */
export interface RepoCommands {
  /** Test, lint, typecheck and build commands, in the order the file lists them. */
  readonly checkCommands: readonly string[];
  /** The command that starts the app for a manual look, if the file names one. */
  readonly devCommand: string | null;
  /** Set when the file is missing or lacks commands the worker needs. */
  readonly warning: string | null;
}

export interface RepoInfo {
  commands(repoPath: string): Promise<RepoCommands>;
  /** The check commands an `AGENTS.md` text lists, in order (empty when it names none). */
  parseCommands(markdown: string): string[];
  /**
   * The dependency-install command for a clean checkout in `dir`, chosen by the lockfile it holds
   * (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`); `null` when there is none.
   * Convention, not per-repository configuration.
   */
  installCommand(dir: string): Promise<string | null>;
}
