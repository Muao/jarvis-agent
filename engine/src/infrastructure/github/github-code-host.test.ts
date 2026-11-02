import { describe, expect, it } from 'vitest';
import { CodeHostError } from './errors.js';
import { GitHubCodeHost } from './github-code-host.js';

const TOKEN = 'github_pat_SECRETSECRETSECRET1234';
const BASE = 'https://api.github.com/repos/o/r';

interface Reply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}
type Handler = Reply | ((url: URL) => Reply);

/** Fake GitHub: routes by "METHOD /path"; records every call. */
function fakeGitHub(routes: Record<string, Handler>) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    calls.push(key);
    const handler = routes[key];
    if (!handler) return json({ message: `no route ${key}` }, 599);
    const reply = typeof handler === 'function' ? handler(url) : handler;
    // Octokit's paginator reads `response.url`, which a bare `new Response` leaves empty.
    return Object.defineProperty(json(reply.body, reply.status ?? 200, reply.headers), 'url', {
      value: url.href,
    });
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

const host = (routes: Record<string, Handler>) => {
  const fake = fakeGitHub(routes);
  return {
    fake,
    host: new GitHubCodeHost({ token: TOKEN, owner: 'o', repo: 'r', fetch: fake.fetch }),
  };
};

const check = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  name: `job-${id}`,
  status: 'completed',
  conclusion: 'success',
  html_url: `https://github.com/o/r/runs/${id}`,
  details_url: `https://github.com/o/r/actions/runs/${1000 + id}/job/${id}`,
  app: { slug: 'github-actions' },
  ...over,
});

const PR = { head: { sha: 'abc123' } };

describe('GitHubCodeHost.snapshot', () => {
  const routes = (): Record<string, Handler> => ({
    [`GET /repos/o/r/pulls/7`]: { body: PR },
    [`GET /repos/o/r/commits/abc123/check-runs`]: {
      body: {
        total_count: 2,
        check_runs: [
          check(1),
          check(2, { status: 'in_progress', conclusion: null, html_url: null }),
        ],
      },
    },
    [`GET /repos/o/r/pulls/7/reviews`]: {
      body: [
        { id: 10, state: 'CHANGES_REQUESTED', user: { login: 'alice' } },
        { id: 11, state: 'COMMENTED', user: { login: 'alice' } },
        { id: 12, state: 'APPROVED', user: { login: 'alice' } },
        { id: 13, state: 'CHANGES_REQUESTED', user: { login: 'bob' } },
        { id: 14, state: 'PENDING', user: { login: 'carol' } },
      ],
    },
    [`GET /repos/o/r/issues/7/comments`]: {
      body: [
        { id: 100, user: { login: 'alice', type: 'User' }, body: 'please fix' },
        { id: 102, user: { login: 'dependabot[bot]', type: 'Bot' }, body: 'bump' },
      ],
    },
    [`GET /repos/o/r/pulls/7/comments`]: {
      body: [
        { id: 101, user: { login: 'github-actions[bot]' }, body: 'lint' },
        { id: 103, user: null, body: null },
      ],
    },
  });

  it('maps checks, latest decisive review per reviewer, and merged comments', async () => {
    const { host: h } = host(routes());
    const snap = await h.snapshot(7);

    expect(snap.headSha).toBe('abc123');
    expect(snap.checks).toEqual([
      {
        id: 1,
        name: 'job-1',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/o/r/runs/1',
      },
      { id: 2, name: 'job-2', status: 'in_progress', conclusion: null },
    ]);
    expect(snap.reviews).toEqual([
      { id: 12, reviewer: 'alice', state: 'approved' },
      { id: 13, reviewer: 'bob', state: 'changes_requested' },
    ]);
    expect(snap.comments).toEqual([
      { id: 'issue:100', author: 'alice', isBot: false, body: 'please fix' },
      { id: 'issue:102', author: 'dependabot[bot]', isBot: true, body: 'bump' },
      { id: 'review:101', author: 'github-actions[bot]', isBot: true, body: 'lint' },
      { id: 'review:103', author: 'ghost', isBot: false, body: '' },
    ]);
  });

  it('falls back to combined commit statuses when checks are forbidden (403)', async () => {
    const r = routes();
    r['GET /repos/o/r/commits/abc123/check-runs'] = {
      status: 403,
      body: { message: 'Resource not accessible by personal access token' },
    };
    r['GET /repos/o/r/commits/abc123/status'] = {
      body: {
        statuses: [
          { id: 5, context: 'ci/build', state: 'success', target_url: 'https://ci/5' },
          { id: 6, context: 'ci/test', state: 'pending', target_url: null },
          { id: 7, context: 'ci/lint', state: 'error', target_url: null },
        ],
      },
    };
    const { host: h } = host(r);
    const snap = await h.snapshot(7);
    expect(snap.checks).toEqual([
      { id: 5, name: 'ci/build', status: 'completed', conclusion: 'success', url: 'https://ci/5' },
      { id: 6, name: 'ci/test', status: 'in_progress', conclusion: null },
      { id: 7, name: 'ci/lint', status: 'completed', conclusion: 'failure' },
    ]);
  });

  it('paginates check runs', async () => {
    const r = routes();
    r['GET /repos/o/r/commits/abc123/check-runs'] = (url) =>
      url.searchParams.get('page') === '2'
        ? { body: { total_count: 2, check_runs: [check(2)] } }
        : {
            body: { total_count: 2, check_runs: [check(1)] },
            headers: {
              link: `<${BASE}/commits/abc123/check-runs?per_page=100&page=2>; rel="next"`,
            },
          };
    const { host: h } = host(r);
    const snap = await h.snapshot(7);
    expect(snap.checks.map((c) => c.id)).toEqual([1, 2]);
  });
});

describe('GitHubCodeHost.rerunFailedChecks', () => {
  it('re-runs each failed Actions workflow run once and ignores other apps', async () => {
    const { host: h, fake } = host({
      'GET /repos/o/r/commits/abc123/check-runs': {
        body: {
          total_count: 5,
          check_runs: [
            check(1, {
              conclusion: 'failure',
              details_url: 'https://github.com/o/r/actions/runs/900/job/1',
            }),
            check(2, {
              conclusion: 'timed_out',
              details_url: 'https://github.com/o/r/actions/runs/900/job/2',
            }),
            check(3, {
              conclusion: 'failure',
              details_url: 'https://github.com/o/r/actions/runs/901/job/3',
            }),
            check(4, { conclusion: 'failure', app: { slug: 'circleci' } }),
            check(5, { conclusion: 'success' }),
          ],
        },
      },
      'POST /repos/o/r/actions/runs/900/rerun-failed-jobs': { body: {} },
      'POST /repos/o/r/actions/runs/901/rerun-failed-jobs': { body: {} },
    });
    await h.rerunFailedChecks(7, 'abc123');
    const posts = fake.calls.filter((c) => c.startsWith('POST'));
    expect(posts.sort()).toEqual([
      'POST /repos/o/r/actions/runs/900/rerun-failed-jobs',
      'POST /repos/o/r/actions/runs/901/rerun-failed-jobs',
    ]);
  });
});

describe('GitHubCodeHost.botLogin / checkConnection', () => {
  it('caches the bot login', async () => {
    const { host: h, fake } = host({ 'GET /user': { body: { login: 'jarvis-bot' } } });
    expect(await h.botLogin()).toBe('jarvis-bot');
    expect(await h.botLogin()).toBe('jarvis-bot');
    expect(fake.calls).toEqual(['GET /user']);
  });

  it('reports login, repo access, scopes and expiry', async () => {
    const { host: h } = host({
      'GET /user': {
        body: { login: 'jarvis-bot' },
        headers: {
          'x-oauth-scopes': 'repo, workflow',
          'github-authentication-token-expiration': '2026-12-01 00:00:00 UTC',
        },
      },
      'GET /repos/o/r': { body: { permissions: { pull: true, push: true, admin: false } } },
    });
    expect(await h.checkConnection()).toEqual({
      login: 'jarvis-bot',
      repoAccess: true,
      permissions: ['repo', 'workflow'],
      expiresAt: '2026-12-01 00:00:00 UTC',
    });
  });

  it('uses repo permissions for fine-grained tokens and reports no repo access on 404', async () => {
    const { host: h } = host({
      'GET /user': { body: { login: 'jarvis-bot' } },
      'GET /repos/o/r': { body: { permissions: { pull: true, push: true, admin: false } } },
    });
    const ok = await h.checkConnection();
    expect(ok.permissions).toEqual(['pull', 'push']);
    expect(ok.expiresAt).toBeNull();

    const { host: denied } = host({
      'GET /user': { body: { login: 'jarvis-bot' } },
      'GET /repos/o/r': { status: 404, body: { message: 'Not Found' } },
    });
    expect(await denied.checkConnection()).toMatchObject({ repoAccess: false, permissions: [] });
  });
});

describe('GitHubCodeHost errors', () => {
  it('wraps failures in CodeHostError with status and masks the token', async () => {
    const { host: h } = host({
      'GET /repos/o/r/pulls/7': {
        status: 401,
        body: { message: `Bad credentials for ${TOKEN}` },
      },
    });
    const error = await h.snapshot(7).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CodeHostError);
    const err = error as CodeHostError;
    expect(err.status).toBe(401);
    expect(err.message).toContain('Bad credentials');
    expect(err.message).not.toContain(TOKEN);
    expect(JSON.stringify(err)).not.toContain(TOKEN);
  });

  it('masks a token shape even when it is not the configured token', async () => {
    const { host: h } = host({
      'GET /user': { status: 500, body: { message: 'leak ghp_abcdefghijklmnop12345' } },
    });
    const err = (await h.botLogin().catch((e: unknown) => e)) as CodeHostError;
    expect(err.message).not.toContain('ghp_abcdefghijklmnop12345');
  });
});
