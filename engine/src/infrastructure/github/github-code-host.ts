import { Octokit } from '@octokit/rest';
import type { CodeHost } from '../../application/ports/code-host.js';
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
const ACTIONS_APP_SLUG = 'github-actions';
const RERUNNABLE: readonly string[] = ['failure', 'timed_out'];
const RUN_ID = /\/actions\/runs\/(\d+)/;

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
  private cachedLogin: string | null = null;

  constructor(options: GitHubCodeHostOptions) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.redact = createRedactor([options.token]);
    this.octokit = new Octokit({
      auth: options.token,
      request: options.fetch ? { fetch: options.fetch } : {},
    });
  }

  async snapshot(prNumber: number): Promise<PullRequestSnapshot> {
    return this.guard(async () => {
      const { owner, repo } = this;
      const pr = await this.octokit.pulls.get({ owner, repo, pull_number: prNumber });
      const headSha = pr.data.head.sha;
      const [checks, reviews, comments] = await Promise.all([
        this.checksFor(headSha),
        this.reviewsFor(prNumber),
        this.commentsFor(prNumber),
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

  async rerunFailedChecks(_prNumber: number, headSha: string): Promise<void> {
    await this.guard(async () => {
      const { owner, repo } = this;
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

  private async checksFor(ref: string): Promise<CheckRun[]> {
    const { owner, repo } = this;
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
      return this.statusesFor(ref);
    }
  }

  private async statusesFor(ref: string): Promise<CheckRun[]> {
    const { owner, repo } = this;
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
  private async reviewsFor(prNumber: number): Promise<PullRequestReview[]> {
    const { owner, repo } = this;
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

  private async commentsFor(prNumber: number): Promise<PullRequestComment[]> {
    const { owner, repo } = this;
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
