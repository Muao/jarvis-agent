/** A fatal, human-readable problem found while starting the engine (bad config, forbidden env). main.ts prints `message` and exits. */
export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupError';
  }
}
