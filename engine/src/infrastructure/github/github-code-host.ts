import { Octokit } from '@octokit/rest';
import type {
  AttachmentResult,
  AttachmentUpload,
  CodeHost,
  RepoTarget,
} from '../../application/ports/code-host.js';
import type {
  CheckConclusion,
  CheckRun,
  CheckRunStatus,
  PullRequestComment,
  PullRequestReview,
  PullRequestSnapshot,
} from '../../domain/index.js';
import { createRedactor } from '../config/redact.js';
import { CodeHostError } from './errors.js';

export interface GitHubCodeHostOptions {
  readonly token: string;
  readonly owner: string;
  readonly repo: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/** What the Connections screen shows for the GitHub row (ADM-08). T11 wraps this in a port. */
export interface GitHubConnectionStatus {
  readonly login: string;
  readonly repoAccess: boolean;
  readonly permissions: readonly string[];
  /** ISO-ish string from `github-authentication-token-expiration`, or null when the token never expires. */
  readonly expiresAt: string | null;
}

export interface ConnectionChecker {
  checkConnection(): Promise<GitHubConnectionStatus>;
}

const CHECK_STATUSES: readonly string[] = ['queued', 'in_progress', 'completed'];
const CONCLUSIONS: readonly string[] = [
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
  'stale',
];
/** The repo one Octokit call is about, in Octokit's own naming. */
interface Where {
  readonly owner: string;
  readonly repo: string;
}

const ACTIONS_APP_SLUG = 'github-actions';
const RERUNNABLE: readonly string[] = ['failure', 'timed_out'];
const RUN_ID = /\/actions\/runs\/(\d+)/;
/**
 * ADR-0023. GitHub documents no API for comment attachments; this is the endpoint its own web
 * UI posts to when an image is dropped into a PR body. It can change or start refusing tokens
 * without notice, which is why every failure here becomes `{ ok: false, reason }`.
 */
const UPLOADS_URL = 'https://uploads.github.com/user-attachments/assets';

interface RawUser {
  login: string;
  type?: string;
}
const isBot = (user: RawUser | null): boolean =>
  user !== null && (user.type === 'Bot' || user.login.endsWith('[bot]'));

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

export class GitHubCodeHost implements CodeHost, ConnectionChecker {
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;
  private readonly redact: (text: string) => string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private cachedLogin: string | null = null;
  private readonly repositoryIds = new Map<string, number>();

  constructor(options: GitHubCodeHostOptions) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.redact = createRedactor([options.token]);
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.octokit = new Octokit({
      auth: options.token,
      request: options.fetch ? { fetch: options.fetch } : {},
    });
  }

  /**
   * ADR-0019: `target` names the repo this call is about. The default repo stands in only when the
   * caller has no target — never as a fallback for one it failed to resolve, because a PR of the
   * same number in the default repo is a different pull request.
   */
  private where(target?: RepoTarget): { owner: string; repo: string } {
    if (target === undefined) return { owner: this.owner, repo: this.repo };
    return { owner: target.owner, repo: target.name };
  }

  async snapshot(prNumber: number, target?: RepoTarget): Promise<PullRequestSnapshot> {
    return this.guard(async () => {
      const where = this.where(target);
      const pr = await this.octokit.pulls.get({ ...where, pull_number: prNumber });
      const headSha = pr.data.head.sha;
      const [checks, reviews, comments] = await Promise.all([
        this.checksFor(where, headSha),
        this.reviewsFor(where, prNumber),
        this.commentsFor(where, prNumber),
      ]);
      return { headSha, checks, reviews, comments };
    });
  }

  async botLogin(): Promise<string> {
    if (this.cachedLogin !== null) return this.cachedLogin;
    const login = await this.guard(
      async () => (await this.octokit.users.getAuthenticated()).data.login,
    );
    this.cachedLogin = login;
    return login;
  }

  async rerunFailedChecks(_prNumber: number, headSha: string, target?: RepoTarget): Promise<void> {
    await this.guard(async () => {
      const { owner, repo } = this.where(target);
      const runs = await this.octokit.paginate(this.octokit.checks.listForRef, {
        owner,
        repo,
        ref: headSha,
        per_page: 100,
      });
      const runIds = new Set<number>();
      for (const run of runs) {
        if (run.app?.slug !== ACTIONS_APP_SLUG) continue;
        if (run.conclusion === null || !RERUNNABLE.includes(run.conclusion)) continue;
        const match = RUN_ID.exec(run.details_url ?? '');
        if (match?.[1]) runIds.add(Number(match[1]));
      }
      for (const runId of runIds) {
        await this.octokit.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: runId });
      }
    });
  }

  async checkConnection(): Promise<GitHubConnectionStatus> {
    return this.guard(async () => {
      const { owner, repo } = this;
      const me = await this.octokit.users.getAuthenticated();
      const scopes = header(me.headers, 'x-oauth-scopes')
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const expiresAt = header(me.headers, 'github-authentication-token-expiration') ?? null;

      let repoAccess = false;
      let repoPermissions: string[] = [];
      try {
        const info = await this.octokit.repos.get({ owner, repo });
        repoAccess = true;
        repoPermissions = Object.entries(info.data.permissions ?? {})
          .filter(([, granted]) => granted)
          .map(([name]) => name);
      } catch (error) {
        const status = statusOf(error);
        if (status !== 403 && status !== 404) throw error;
      }
      return {
        login: me.data.login,
        repoAccess,
        // Classic PATs list scopes; fine-grained PATs send none, so the repo permissions stand in.
        permissions: scopes && scopes.length > 0 ? scopes : repoPermissions,
        expiresAt,
      };
    });
  }

  private async checksFor(where: Where, ref: string): Promise<CheckRun[]> {
    const { owner, repo } = where;
    try {
      const runs = await this.octokit.paginate(this.octokit.checks.listForRef, {
        owner,
        repo,
        ref,
        per_page: 100,
      });
      return runs.map((run) => ({
        id: run.id,
        name: run.name,
        status: toStatus(run.status),
        conclusion: toConclusion(run.conclusion),
        ...(run.html_url ? { url: run.html_url } : {}),
      }));
    } catch (error) {
      // A fine-grained PAT without "Checks: read" gets 403; commit statuses need only "Commit statuses: read".
      if (statusOf(error) !== 403) throw error;
      return this.statusesFor(where, ref);
    }
  }

  private async statusesFor(where: Where, ref: string): Promise<CheckRun[]> {
    const { owner, repo } = where;
    const combined = await this.octokit.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref,
      per_page: 100,
    });
    return combined.data.statuses.map((s) => ({
      id: s.id,
      name: s.context,
      status: s.state === 'pending' ? 'in_progress' : 'completed',
      conclusion: s.state === 'success' ? 'success' : s.state === 'pending' ? null : 'failure',
      ...(s.target_url ? { url: s.target_url } : {}),
    }));
  }

  /** Latest decisive review per reviewer: comment-only reviews do not change a verdict. */
  private async reviewsFor(where: Where, prNumber: number): Promise<PullRequestReview[]> {
    const { owner, repo } = where;
    const raw = await this.octokit.paginate(this.octokit.pulls.listReviews, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    const latest = new Map<string, PullRequestReview>();
    for (const review of [...raw].sort((a, b) => a.id - b.id)) {
      const reviewer = review.user?.login;
      if (!reviewer) continue;
      const state =
        review.state === 'APPROVED'
          ? 'approved'
          : review.state === 'CHANGES_REQUESTED'
            ? 'changes_requested'
            : review.state === 'DISMISSED'
              ? 'pending'
              : null;
      if (state !== null) latest.set(reviewer.toLowerCase(), { id: review.id, reviewer, state });
    }
    return [...latest.values()];
  }

  private async commentsFor(where: Where, prNumber: number): Promise<PullRequestComment[]> {
    const { owner, repo } = where;
    const [issue, review] = await Promise.all([
      this.octokit.paginate(this.octokit.issues.listComments, {
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100,
      }),
      this.octokit.paginate(this.octokit.pulls.listReviewComments, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      }),
    ]);
    const toComment =
      (source: 'issue' | 'review') =>
      (c: { id: number; user: RawUser | null; body?: string | null }) => ({
        id: `${source}:${c.id}`,
        author: c.user?.login ?? 'ghost',
        isBot: isBot(c.user),
        body: c.body ?? '',
      });
    return [...issue.map(toComment('issue')), ...review.map(toComment('review'))];
  }

  /**
   * ADR-0023. Uploads one image the way the GitHub web UI does and returns the
   * `github.com/user-attachments/assets/...` URL to embed in a PR body. Never throws: the caller
   * (and through it the agent) gets a reason and writes a plain line into the PR instead.
   */
  async uploadAttachment(upload: AttachmentUpload): Promise<AttachmentResult> {
    const owner = upload.repo?.owner ?? this.owner;
    const repo = upload.repo?.name ?? this.repo;
    let repositoryId: number;
    try {
      repositoryId = await this.repositoryId(owner, repo);
    } catch (error) {
      return { ok: false, reason: this.reasonOf(error) };
    }

    const url = new URL(UPLOADS_URL);
    url.searchParams.set('name', upload.name);
    url.searchParams.set('content_type', upload.contentType);
    url.searchParams.set('repository_id', String(repositoryId));

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          'content-type': upload.contentType,
        },
        body: upload.bytes,
      });
    } catch (error) {
      return { ok: false, reason: this.reasonOf(error) };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        ok: false,
        reason: this.redact(
          `GitHub refused the upload with ${response.status}${body === '' ? '' : `: ${body.slice(0, 200)}`}. ` +
            'This endpoint is undocumented (ADR-0023); the token may not be accepted for it.',
        ),
      };
    }

    const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const href = ['href', 'url', 'asset_url'].reduce<string | null>((found, key) => {
      if (found !== null) return found;
      const value = parsed?.[key];
      return typeof value === 'string' && value !== '' ? value : null;
    }, null);
    if (href === null) {
      return { ok: false, reason: 'GitHub accepted the upload but returned no asset URL.' };
    }
    return { ok: true, url: href };
  }

  private async repositoryId(owner: string, repo: string): Promise<number> {
    const key = `${owner}/${repo}`;
    const cached = this.repositoryIds.get(key);
    if (cached !== undefined) return cached;
    const { data } = await this.guard(() => this.octokit.repos.get({ owner, repo }));
    this.repositoryIds.set(key, data.id);
    return data.id;
  }

  private reasonOf(error: unknown): string {
    return this.redact(error instanceof Error ? error.message : String(error));
  }

  private async guard<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof CodeHostError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new CodeHostError(`GitHub request failed: ${this.redact(message)}`, statusOf(error));
    }
  }
}

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function toStatus(value: string): CheckRunStatus {
  // `waiting`, `pending`, `requested` are queued variants for our purposes.
  return CHECK_STATUSES.includes(value) ? (value as CheckRunStatus) : 'queued';
}

function toConclusion(value: string | null): CheckConclusion | null {
  if (value === null) return null;
  return CONCLUSIONS.includes(value) ? (value as CheckConclusion) : 'neutral';
}
