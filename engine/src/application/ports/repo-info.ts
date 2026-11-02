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
}
