import type { PullRequestSnapshot } from '../../domain/index.js';

/**
 * ADR-0012: a task may target a repo other than the default one, so every call that names a PR
 * has to name the repo that PR lives in. Absent means the host's own (default) repo.
 */
export interface RepoTarget {
  readonly owner: string;
  readonly name: string;
}

/** One image the agent wants inline in a PR body (ADR-0014). */
export interface AttachmentUpload {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  /** The repo the attachment belongs to; the host's own repo when absent (ADR-0012). */
  readonly repo?: RepoTarget;
}

/**
 * ADR-0014: the upload goes through an endpoint GitHub does not document, so failure is an
 * ordinary answer the agent can work around, not an exception.
 */
export type AttachmentResult =
  { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string };

/**
 * ADR-0018: posting a comment can fail for the same mundane reasons an upload can (no permission,
 * a locked PR, the host having a bad day), and a failed comment must not throw away a check that
 * otherwise worked. So it answers with a value, exactly as `uploadAttachment` does.
 */
export type CommentResult =
  | { readonly ok: true; readonly url: string; readonly id: number }
  | { readonly ok: false; readonly reason: string };

/**
 * ADR-0018: who wrote a pull request, where its head lives and what it says about itself. The
 * `title` and `body` are authored by whoever opened the PR, so they are untrusted content
 * (ADR-0017) and only ever reach a prompt wrapped.
 */
export interface PullRequestDescription {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly headRef: string;
  readonly headSha: string;
  /** The repo the head branch lives in; differs from the base repo for a fork. */
  readonly headRepo: RepoTarget;
  readonly fromFork: boolean;
}

export interface CreatePullRequestInput {
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

export type CreatePullRequestResult =
  | { readonly ok: true; readonly number: number; readonly url: string; readonly created: boolean }
  | { readonly ok: false; readonly reason: string };

export interface FailedCheckLog {
  readonly name: string;
  readonly conclusion: string;
  readonly url: string | null;
  readonly logTail: string | null;
}

/** The pull-request host (GitHub in ADR-0007). The watcher polls it; nothing here calls a model. */
export interface CodeHost {
  /**
   * The current state of one PR: checks of its head commit, reviews and comments. `repo` names
   * the repo the PR lives in (ADR-0012); without it the PR is read from the default repo, where a
   * PR of the same number would be a different pull request entirely.
   */
  snapshot(prNumber: number, repo?: RepoTarget): Promise<PullRequestSnapshot>;
  /** The login Jarvis posts as; its own comments never trigger work (CI-06). */
  botLogin(): Promise<string>;
  /** Ask the host to run the failed checks of `headSha` again (flaky CI, CI-04). */
  rerunFailedChecks(prNumber: number, headSha: string, repo?: RepoTarget): Promise<void>;
  /** Uploads an image and returns the URL to embed in a PR body (ADR-0014). */
  uploadAttachment(upload: AttachmentUpload): Promise<AttachmentResult>;
  /**
   * ADR-0018: the PR itself — author, head, state and the text it carries. Needed before running a
   * pull request's code (is this head trusted?) and to derive check scenarios when there is no
   * `spec.md`.
   */
  describePullRequest(prNumber: number, repo?: RepoTarget): Promise<PullRequestDescription>;
  /**
   * ADR-0018: a comment on a PR. Only ever called after the owner approved it; the agent has no
   * path to this that does not go through a permission card. The `id` comes back so a later run
   * can replace what it wrote.
   */
  postComment(prNumber: number, body: string, repo?: RepoTarget): Promise<CommentResult>;
  /**
   * ADR-0018: replace the text of a comment Jarvis posted earlier, behind the same card. The
   * caller checks that the comment belongs to the task before asking; this only does the write.
   */
  editComment(commentId: number, body: string, repo?: RepoTarget): Promise<CommentResult>;
  /**
   * ADR-0022: opens a **draft** pull request from `head` into `base`. When an open PR for the head
   * exists it is returned instead (`created: false`), never a second one. A refusal is a value.
   */
  createPullRequest(
    input: CreatePullRequestInput,
    repo?: RepoTarget,
  ): Promise<CreatePullRequestResult>;
  /**
   * ADR-0022: the failed checks of `headSha` with the tail of their logs, for a fix round. A
   * check that is not an Actions job has `logTail: null`. The text is untrusted (ADR-0017).
   */
  failedCheckLogs(
    prNumber: number,
    headSha: string,
    repo?: RepoTarget,
  ): Promise<readonly FailedCheckLog[]>;
}
