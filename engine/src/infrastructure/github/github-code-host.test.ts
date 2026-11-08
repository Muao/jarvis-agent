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

describe('GitHubCodeHost: a repo other than its own (ADR-0012)', () => {
  const TARGET = { owner: 'other', name: 'repo' };

  it('asks the target repo for every part of the snapshot', async () => {
    const { host: h, fake } = host({
      'GET /repos/other/repo/pulls/7': { body: PR },
      'GET /repos/other/repo/commits/abc123/check-runs': {
        body: { total_count: 1, check_runs: [check(1)] },
      },
      'GET /repos/other/repo/pulls/7/reviews': { body: [] },
      'GET /repos/other/repo/issues/7/comments': { body: [] },
      'GET /repos/other/repo/pulls/7/comments': { body: [] },
    });

    const snap = await h.snapshot(7, TARGET);

    expect(snap.headSha).toBe('abc123');
    expect(snap.checks.map((c) => c.id)).toEqual([1]);
    // Not one call went to the host's own repo: a PR #7 there is a different pull request.
    expect(fake.calls.filter((c) => c.includes('/repos/o/r/'))).toEqual([]);
  });

  it('re-runs the failed checks in the target repo', async () => {
    const { host: h, fake } = host({
      'GET /repos/other/repo/commits/abc123/check-runs': {
        body: {
          total_count: 1,
          check_runs: [
            check(1, {
              conclusion: 'failure',
              details_url: 'https://github.com/other/repo/actions/runs/900/job/1',
            }),
          ],
        },
      },
      'POST /repos/other/repo/actions/runs/900/rerun-failed-jobs': { body: {} },
    });

    await h.rerunFailedChecks(7, 'abc123', TARGET);

    expect(fake.calls.filter((c) => c.startsWith('POST'))).toEqual([
      'POST /repos/other/repo/actions/runs/900/rerun-failed-jobs',
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

describe('GitHubCodeHost.uploadAttachment (ADR-0014)', () => {
  const UPLOAD = 'POST /user-attachments/assets';
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const upload = { name: 'shot.png', contentType: 'image/png', bytes };

  it('posts the bytes with the repository id and returns the asset URL (AC-18)', async () => {
    const h = host({
      'GET /repos/o/r': { body: { id: 42 } },
      [UPLOAD]: (url) => {
        expect(url.searchParams.get('name')).toBe('shot.png');
        expect(url.searchParams.get('content_type')).toBe('image/png');
        expect(url.searchParams.get('repository_id')).toBe('42');
        return { body: { href: 'https://github.com/user-attachments/assets/u-1' } };
      },
    });

    expect(await h.host.uploadAttachment(upload)).toEqual({
      ok: true,
      url: 'https://github.com/user-attachments/assets/u-1',
    });
  });

  it("resolves the repository id of the task's own repo (ADR-0012)", async () => {
    const h = host({
      'GET /repos/other/sandbox': { body: { id: 99 } },
      [UPLOAD]: (url) => ({
        body: {
          url: `https://github.com/user-attachments/assets/${url.searchParams.get('repository_id')}`,
        },
      }),
    });

    const result = await h.host.uploadAttachment({
      ...upload,
      repo: { owner: 'other', name: 'sandbox' },
    });

    expect(result).toEqual({ ok: true, url: 'https://github.com/user-attachments/assets/99' });
  });

  it('asks for a repository id only once', async () => {
    const h = host({
      'GET /repos/o/r': { body: { id: 42 } },
      [UPLOAD]: { body: { href: 'https://github.com/user-attachments/assets/u-1' } },
    });

    await h.host.uploadAttachment(upload);
    await h.host.uploadAttachment(upload);

    expect(h.fake.calls.filter((c) => c === 'GET /repos/o/r')).toHaveLength(1);
  });

  it('turns a refusal into a reason instead of throwing, and names the ADR (AC-19)', async () => {
    for (const status of [401, 403, 404, 410, 500]) {
      const h = host({
        'GET /repos/o/r': { body: { id: 42 } },
        [UPLOAD]: { status, body: { message: 'nope' } },
      });

      const result = await h.host.uploadAttachment(upload);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a refusal');
      expect(result.reason).toContain(String(status));
      expect(result.reason).toContain('undocumented');
    }
  });

  it('never puts the token in the reason (SEC-04)', async () => {
    const h = host({
      'GET /repos/o/r': { body: { id: 42 } },
      [UPLOAD]: { status: 401, body: { message: `bad token ${TOKEN}` } },
    });

    const result = await h.host.uploadAttachment(upload);

    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).not.toContain(TOKEN);
  });

  it('reports a failure to resolve the repository as a reason, not an exception', async () => {
    const h = host({ [UPLOAD]: { body: { href: 'x' } } });

    const result = await h.host.uploadAttachment(upload);

    expect(result.ok).toBe(false);
  });

  it('refuses when GitHub accepts the upload but names no asset', async () => {
    const h = host({
      'GET /repos/o/r': { body: { id: 42 } },
      [UPLOAD]: { body: { ok: true } },
    });

    expect(await h.host.uploadAttachment(upload)).toEqual({
      ok: false,
      reason: 'GitHub accepted the upload but returned no asset URL.',
    });
  });
});
