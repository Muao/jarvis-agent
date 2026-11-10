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

describe('GitHubCodeHost.createPullRequest (ADR-0022)', () => {
  const input = { head: 'jarvis/T-1', base: 'main', title: 'Add x', body: 'Body' };
  const LIST = 'GET /repos/o/r/pulls';
  const CREATE = 'POST /repos/o/r/pulls';

  /** Like `host`, but also keeps the JSON body of every request and the query of the list. */
  function recording(routes: Record<string, Handler>) {
    const fake = fakeGitHub(routes);
    const bodies: { key: string; query: string; body: unknown }[] = [];
    const wrapped = (async (inputUrl: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof inputUrl === 'string'
          ? inputUrl
          : inputUrl instanceof URL
            ? inputUrl.href
            : inputUrl.url,
      );
      bodies.push({
        key: `${init?.method ?? 'GET'} ${url.pathname}`,
        query: url.search,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
      });
      return fake.fetch(inputUrl, init);
    }) as typeof fetch;
    return {
      bodies,
      calls: fake.calls,
      host: new GitHubCodeHost({ token: TOKEN, owner: 'o', repo: 'r', fetch: wrapped }),
    };
  }

  it('creates a draft PR from the head into the base when none is open', async () => {
    const h = recording({
      [LIST]: { body: [] },
      [CREATE]: { status: 201, body: { number: 7, html_url: 'https://github.com/o/r/pull/7' } },
    });

    expect(await h.host.createPullRequest(input)).toEqual({
      ok: true,
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      created: true,
    });

    const list = h.bodies.find((b) => b.key === LIST);
    expect(new URLSearchParams(list?.query).get('head')).toBe('o:jarvis/T-1');
    expect(new URLSearchParams(list?.query).get('state')).toBe('open');
    expect(h.bodies.find((b) => b.key === CREATE)?.body).toEqual({
      head: 'jarvis/T-1',
      base: 'main',
      title: 'Add x',
      body: 'Body',
      draft: true,
    });
  });

  it('returns the open PR for the head instead of creating a second', async () => {
    const h = recording({
      [LIST]: { body: [{ number: 5, html_url: 'https://github.com/o/r/pull/5' }] },
    });

    expect(await h.host.createPullRequest(input)).toEqual({
      ok: true,
      number: 5,
      url: 'https://github.com/o/r/pull/5',
      created: false,
    });
    expect(h.calls).not.toContain(CREATE);
  });

  it('resolves a 422 "already exists" to the existing PR', async () => {
    let listed = 0;
    const h = recording({
      [LIST]: () => {
        listed += 1;
        return {
          body: listed === 1 ? [] : [{ number: 9, html_url: 'https://github.com/o/r/pull/9' }],
        };
      },
      [CREATE]: {
        status: 422,
        body: {
          message: 'Validation Failed',
          errors: [{ message: 'A pull request already exists for o:jarvis/T-1.' }],
        },
      },
    });

    expect(await h.host.createPullRequest(input)).toMatchObject({
      ok: true,
      number: 9,
      created: false,
    });
  });

  it('targets another repo when given one (ADR-0012)', async () => {
    const h = recording({
      'GET /repos/x/y/pulls': { body: [] },
      'POST /repos/x/y/pulls': { status: 201, body: { number: 3, html_url: 'u' } },
    });

    expect(await h.host.createPullRequest(input, { owner: 'x', name: 'y' })).toMatchObject({
      ok: true,
      number: 3,
    });
    expect(new URLSearchParams(h.bodies[0]?.query).get('head')).toBe('x:jarvis/T-1');
  });

  it('answers a refusal as a value, with the token redacted', async () => {
    const h = recording({
      [LIST]: { body: [] },
      [CREATE]: { status: 403, body: { message: `no access for ${TOKEN}` } },
    });

    const result = await h.host.createPullRequest(input);

    if (result.ok) throw new Error('expected a refusal');
    expect(result.reason).toContain('403');
    expect(result.reason).not.toContain(TOKEN);
  });

  it('answers a failed lookup as a value too', async () => {
    const h = recording({ [LIST]: { status: 500, body: { message: 'boom' } } });

    expect((await h.host.createPullRequest(input)).ok).toBe(false);
  });
});

describe('GitHubCodeHost.failedCheckLogs (ADR-0022)', () => {
  const runs = (items: unknown[]) => ({
    'GET /repos/o/r/commits/abc123/check-runs': {
      body: { total_count: items.length, check_runs: items },
    },
  });
  /** Job logs are plain text, not JSON: this fake serves them as such. */
  function withLogs(
    routes: Record<string, Handler>,
    logs: Record<string, { status?: number; text: string }>,
  ) {
    const base = fakeGitHub(routes);
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const log = logs[url.pathname];
      if (log !== undefined) {
        base.calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        return Object.defineProperty(
          new Response(log.text, {
            status: log.status ?? 200,
            headers: { 'content-type': 'text/plain' },
          }),
          'url',
          { value: url.href },
        );
      }
      return base.fetch(input, init);
    }) as typeof fetch;
    return new GitHubCodeHost({ token: TOKEN, owner: 'o', repo: 'r', fetch: fetchFn });
  }

  const failed = (id: number, over: Record<string, unknown> = {}) =>
    check(id, { conclusion: 'failure', ...over });

  it('returns each failed Actions job with the last 200 lines of its log', async () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
    const host = withLogs(runs([check(1), failed(2)]), {
      '/repos/o/r/actions/jobs/2/logs': { text: lines },
    });

    const result = await host.failedCheckLogs(7, 'abc123');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'job-2',
      conclusion: 'failure',
      url: 'https://github.com/o/r/runs/2',
    });
    const tail = (result[0]?.logTail ?? '').split('\n');
    expect(tail).toHaveLength(200);
    expect(tail[0]).toBe('line 301');
    expect(tail.at(-1)).toBe('line 500');
  });

  it('gives a check that is not an Actions job a null log, and never fetches one', async () => {
    const h = host(runs([failed(3, { app: { slug: 'circleci' } })]));

    const result = await h.host.failedCheckLogs(7, 'abc123');

    expect(result).toEqual([
      { name: 'job-3', conclusion: 'failure', url: 'https://github.com/o/r/runs/3', logTail: null },
    ]);
    expect(h.fake.calls.some((c) => c.includes('/logs'))).toBe(false);
  });

  it('counts timed-out jobs as failed and ignores skipped ones', async () => {
    const host = withLogs(
      runs([failed(4, { conclusion: 'timed_out' }), check(5, { conclusion: 'skipped' })]),
      { '/repos/o/r/actions/jobs/4/logs': { text: 'x' } },
    );

    const result = await host.failedCheckLogs(7, 'abc123');

    expect(result.map((r) => [r.name, r.conclusion])).toEqual([['job-4', 'timed_out']]);
  });

  it('keeps all logs together under 200 KB', async () => {
    const big = Array.from({ length: 200 }, () => 'y'.repeat(900)).join('\n');
    const host = withLogs(runs([failed(1), failed(2), failed(3)]), {
      '/repos/o/r/actions/jobs/1/logs': { text: big },
      '/repos/o/r/actions/jobs/2/logs': { text: big },
      '/repos/o/r/actions/jobs/3/logs': { text: big },
    });

    const result = await host.failedCheckLogs(7, 'abc123');

    const total = result.reduce((n, r) => n + Buffer.byteLength(r.logTail ?? ''), 0);
    expect(total).toBeLessThanOrEqual(200 * 1024);
    expect(result).toHaveLength(3);
  });

  it('yields a null log when the download fails, not an error', async () => {
    const host = withLogs(runs([failed(2)]), {
      '/repos/o/r/actions/jobs/2/logs': { status: 410, text: 'gone' },
    });

    expect((await host.failedCheckLogs(7, 'abc123'))[0]?.logTail).toBeNull();
  });

  it('rejects, token redacted, when the checks cannot be listed', async () => {
    const h = host({
      'GET /repos/o/r/commits/abc123/check-runs': {
        status: 500,
        body: { message: `down ${TOKEN}` },
      },
    });

    const error = await h.host.failedCheckLogs(7, 'abc123').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CodeHostError);
    expect((error as Error).message).not.toContain(TOKEN);
  });
});
