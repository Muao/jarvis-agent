import type { PullRequestSnapshot } from '../../domain/index.js';

/**
 * ADR-0019: a task may target a repo other than the default one, so every call that names a PR
 * has to name the repo that PR lives in. Absent means the host's own (default) repo.
 */
export interface RepoTarget {
  readonly owner: string;
  readonly name: string;
}

/** One image the agent wants inline in a PR body (ADR-0023). */
export interface AttachmentUpload {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  /** The repo the attachment belongs to; the host's own repo when absent (ADR-0019). */
  readonly repo?: RepoTarget;
}

/**
 * ADR-0023: the upload goes through an endpoint GitHub does not document, so failure is an
 * ordinary answer the agent can work around, not an exception.
 */
export type AttachmentResult =
  { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string };

/** The pull-request host (GitHub in ADR-0009). The watcher polls it; nothing here calls a model. */
export interface CodeHost {
  /**
   * The current state of one PR: checks of its head commit, reviews and comments. `repo` names
   * the repo the PR lives in (ADR-0019); without it the PR is read from the default repo, where a
   * PR of the same number would be a different pull request entirely.
   */
  snapshot(prNumber: number, repo?: RepoTarget): Promise<PullRequestSnapshot>;
  /** The login Jarvis posts as; its own comments never trigger work (CI-06). */
  botLogin(): Promise<string>;
  /** Ask the host to run the failed checks of `headSha` again (flaky CI, CI-04). */
  rerunFailedChecks(prNumber: number, headSha: string, repo?: RepoTarget): Promise<void>;
  /** Uploads an image and returns the URL to embed in a PR body (ADR-0023). */
  uploadAttachment(upload: AttachmentUpload): Promise<AttachmentResult>;
}
