/** Is the database reachable? Rejects when it is not. */
export interface DatabasePing {
  ping(): Promise<void>;
}
