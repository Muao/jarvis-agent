import type { PullRequestSnapshot } from '../../domain/index.js';
import type {
  AttachmentResult,
  AttachmentUpload,
  CodeHost,
  RepoTarget,
} from '../ports/code-host.js';

const slug = (repo?: RepoTarget): string | null =>
  repo === undefined ? null : `${repo.owner}/${repo.name}`;

/** A PR is identified by its repo *and* its number: #7 means a different PR in another repo. */
const key = (prNumber: number, repo?: RepoTarget): string =>
  `${slug(repo) ?? '(default)'}#${prNumber}`;

/** A code host that answers with the snapshot a test set for each PR, and records re-runs. */
export class FakeCodeHost implements CodeHost {
  /** Whoever Jarvis posts as; set `login` to test the bot filter. */
  login = 'jarvis-bot';
  readonly reruns: {
    readonly prNumber: number;
    readonly headSha: string;
    readonly repo: string | null;
  }[] = [];
  /** How often `snapshot` was called, per PR (a poll that found nothing still reads). */
  readonly reads: number[] = [];
  /** The repo each `snapshot` named, in order; null is the default repo (ADR-0019). */
  readonly readRepos: (string | null)[] = [];
  /** Every attachment the engine tried to upload, in order. */
  readonly uploads: AttachmentUpload[] = [];
  /** What `uploadAttachment` answers; the default pretends GitHub accepted it. */
  uploadResult: AttachmentResult = {
    ok: true,
    url: 'https://github.com/user-attachments/assets/u1',
  };
  private readonly snapshots = new Map<string, PullRequestSnapshot | Error>();
  private rerunFailure: Error | null = null;

  /** What `snapshot(prNumber)` returns from now on **in the default repo**; an `Error` makes it reject. */
  set(prNumber: number, snapshot: PullRequestSnapshot | Error): void {
    this.snapshots.set(key(prNumber), snapshot);
  }

  /**
   * The same, for a PR in a task's target repo (ADR-0019). A caller that asks the default repo for
   * this PR gets "no snapshot", which is what the real host's 404 looks like.
   */
  setFor(repo: RepoTarget, prNumber: number, snapshot: PullRequestSnapshot | Error): void {
    this.snapshots.set(key(prNumber, repo), snapshot);
  }

  /** The next `rerunFailedChecks` rejects with `error`. */
  failNextRerun(error: Error): void {
    this.rerunFailure = error;
  }

  async snapshot(prNumber: number, repo?: RepoTarget): Promise<PullRequestSnapshot> {
    this.reads.push(prNumber);
    this.readRepos.push(slug(repo));
    const scripted = this.snapshots.get(key(prNumber, repo));
    if (scripted === undefined) {
      throw new Error(
        `fake code host: no snapshot for PR ${prNumber} in ${slug(repo) ?? 'the default repo'}`,
      );
    }
    if (scripted instanceof Error) throw scripted;
    return scripted;
  }

  async botLogin(): Promise<string> {
    return this.login;
  }

  async rerunFailedChecks(prNumber: number, headSha: string, repo?: RepoTarget): Promise<void> {
    if (this.rerunFailure !== null) {
      const error = this.rerunFailure;
      this.rerunFailure = null;
      throw error;
    }
    this.reruns.push({ prNumber, headSha, repo: slug(repo) });
  }

  async uploadAttachment(upload: AttachmentUpload): Promise<AttachmentResult> {
    this.uploads.push(upload);
    return this.uploadResult;
  }
}
