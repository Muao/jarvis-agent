import type { PullRequestSnapshot } from '../../domain/index.js';
import type { CodeHost } from '../ports/code-host.js';

/** A code host that answers with the snapshot a test set for each PR, and records re-runs. */
export class FakeCodeHost implements CodeHost {
  /** Whoever Jarvis posts as; set `login` to test the bot filter. */
  login = 'jarvis-bot';
  readonly reruns: { readonly prNumber: number; readonly headSha: string }[] = [];
  /** How often `snapshot` was called, per PR (a poll that found nothing still reads). */
  readonly reads: number[] = [];
  private readonly snapshots = new Map<number, PullRequestSnapshot | Error>();
  private rerunFailure: Error | null = null;

  /** What `snapshot(prNumber)` returns from now on; an `Error` makes it reject. */
  set(prNumber: number, snapshot: PullRequestSnapshot | Error): void {
    this.snapshots.set(prNumber, snapshot);
  }

  /** The next `rerunFailedChecks` rejects with `error`. */
  failNextRerun(error: Error): void {
    this.rerunFailure = error;
  }

  async snapshot(prNumber: number): Promise<PullRequestSnapshot> {
    this.reads.push(prNumber);
    const scripted = this.snapshots.get(prNumber);
    if (scripted === undefined) throw new Error(`fake code host: no snapshot for PR ${prNumber}`);
    if (scripted instanceof Error) throw scripted;
    return scripted;
  }

  async botLogin(): Promise<string> {
    return this.login;
  }

  async rerunFailedChecks(prNumber: number, headSha: string): Promise<void> {
    if (this.rerunFailure !== null) {
      const error = this.rerunFailure;
      this.rerunFailure = null;
      throw error;
    }
    this.reruns.push({ prNumber, headSha });
  }
}
