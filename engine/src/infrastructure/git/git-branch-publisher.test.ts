import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitBranchPublisher } from './git-branch-publisher.js';
import { type Fixture, git, makeFixture } from './git-branch-publisher.fixture.js';
import { GitError, runGit } from './run-git.js';

const TOKEN = 'FAKE-PUSH-TOKEN-0123456789';
const B64 = Buffer.from(`x-access-token:${TOKEN}`, 'utf8').toString('base64');
const ENGINE_ENV = {
  PATH: process.env['PATH'],
  HOME: process.env['HOME'],
  GITHUB_TOKEN: TOKEN,
  DATABASE_URL: 'postgres://u:p@db/x',
};

interface Call {
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv | undefined;
}

let fx: Fixture;
beforeEach(async () => {
  fx = await makeFixture();
});
afterEach(() => fx.cleanup());

function publisher(over: { runGit?: typeof runGit; remoteUrl?: (r: unknown) => string } = {}) {
  const calls: Call[] = [];
  const recording: typeof runGit = (args, options) => {
    calls.push({ args, cwd: options.cwd, env: options.env });
    return (over.runGit ?? runGit)(args, options);
  };
  return {
    calls,
    publisher: new GitBranchPublisher({
      token: TOKEN,
      worktreesDir: fx.worktreesDir,
      baseBranch: 'main',
      remote: 'origin',
      env: ENGINE_ENV,
      remoteUrl: () => `file://${fx.bare}`,
      runGit: recording,
      ...(over.remoteUrl === undefined ? {} : { remoteUrl: over.remoteUrl }),
    }),
  };
}

describe('GitBranchPublisher.headSha / status', () => {
  it('reads HEAD of the task worktree', async () => {
    const sha = fx.commit('b.txt');

    expect(await publisher().publisher.headSha('T-1')).toBe(sha);
  });

  it('reports a clean tree one commit ahead, with the changed files', async () => {
    fx.commit('b.txt');
    fx.commit('src/c.ts');

    expect(await publisher().publisher.status('T-1')).toEqual({
      dirtyFiles: [],
      commitsAhead: 2,
      changedFiles: ['b.txt', 'src/c.ts'],
    });
  });

  it('lists modified, staged and untracked files as dirty, and not ignored ones', async () => {
    fx.commit('.gitignore', 'ignored.log\n');
    fx.commit('b.txt');
    writeFileSync(join(fx.worktree, 'a.txt'), 'changed');
    writeFileSync(join(fx.worktree, 'staged.txt'), 's');
    git(fx.worktree, 'add', 'staged.txt');
    writeFileSync(join(fx.worktree, 'untracked file.txt'), 'u');
    writeFileSync(join(fx.worktree, 'ignored.log'), 'i');

    const { dirtyFiles } = await publisher().publisher.status('T-1');

    expect([...dirtyFiles].sort()).toEqual(['a.txt', 'staged.txt', 'untracked file.txt']);
  });

  it('counts zero commits ahead on a fresh worktree', async () => {
    expect((await publisher().publisher.status('T-1')).commitsAhead).toBe(0);
  });

  it('uses the fetched remote base, and the local one when there is no remote', async () => {
    fx.commit('b.txt');
    // Move origin/main ahead of the worktree's branch point: the branch is still one ahead.
    git(fx.repo, 'commit', '--allow-empty', '-qm', 'upstream');
    git(fx.repo, 'push', '-q', 'origin', 'main');
    git(fx.repo, 'fetch', '-q', 'origin');
    expect((await publisher().publisher.status('T-1')).changedFiles).toEqual(['b.txt']);

    git(fx.repo, 'remote', 'remove', 'origin');
    expect((await publisher().publisher.status('T-1')).commitsAhead).toBe(1);
  });

  it('does not touch the network to resolve the base', async () => {
    fx.commit('b.txt');
    const { calls, publisher: p } = publisher();

    await p.status('T-1');

    expect(calls.some((c) => c.args.includes('fetch'))).toBe(false);
  });

  it('rejects a task id that is not a task id', async () => {
    await expect(publisher().publisher.status('../x')).rejects.toThrow(/Invalid task id/);
  });
});

describe('GitBranchPublisher.push: what is run (ADR-0022)', () => {
  const pushCall = (calls: Call[]) => {
    const call = calls.find((c) => c.args.includes('push'));
    if (call === undefined) throw new Error('no push was run');
    return call;
  };

  it('pushes the exact sha to jarvis/<task-id>, with an explicit refspec and no force', async () => {
    const sha = fx.commit('b.txt');
    const h = publisher();

    expect(await h.publisher.push({ taskId: 'T-1', repo: { owner: 'o', name: 'r' }, sha })).toEqual(
      { ok: true },
    );

    const { args } = pushCall(h.calls);
    expect(args.at(-1)).toBe(`${sha}:refs/heads/jarvis/T-1`);
    expect(args.at(-2)).toBe(`file://${fx.bare}`);
    expect(args).toContain('--no-verify');
    for (const forbidden of [
      '--force',
      '-f',
      '--force-with-lease',
      '--all',
      '--tags',
      '--mirror',
      '--delete',
    ]) {
      expect(args).not.toContain(forbidden);
    }
    expect(args.filter((a) => a.startsWith('+') || a.startsWith(':'))).toEqual([]);
  });

  it('disables hooks, credential helpers and the other things a repository can configure', async () => {
    const sha = fx.commit('b.txt');
    const h = publisher();

    await h.publisher.push({ taskId: 'T-1', repo: { owner: 'o', name: 'r' }, sha });

    const { args } = pushCall(h.calls);
    for (const setting of [
      'core.hooksPath=/dev/null',
      'credential.helper=',
      'core.fsmonitor=false',
      'core.sshCommand=false',
      'core.askPass=',
      'http.proxy=',
    ]) {
      const at = args.indexOf(setting);
      expect(at, setting).toBeGreaterThan(0);
      expect(args[at - 1], setting).toBe('-c');
    }
  });

  it('builds the GitHub URL from the repo it was given, never from the repository’s remote', async () => {
    const sha = fx.commit('b.txt');
    git(fx.repo, 'remote', 'set-url', 'origin', 'https://evil.example/x/y.git');
    git(fx.repo, 'remote', 'set-url', '--push', 'origin', 'https://evil.example/x/y.git');
    const calls: Call[] = [];
    const p = new GitBranchPublisher({
      token: TOKEN,
      worktreesDir: fx.worktreesDir,
      baseBranch: 'main',
      remote: 'origin',
      env: ENGINE_ENV,
      // No override: the real URL. The push itself fails (no network needed to see the argv).
      runGit: (args, options) => {
        calls.push({ args, cwd: options.cwd, env: options.env });
        if (args.includes('push')) return Promise.reject(new GitError(args, 128, 'unreachable'));
        return runGit(args, options);
      },
    });

    await p.push({ taskId: 'T-1', repo: { owner: 'burnjohn', name: 'quick-blog' }, sha });

    expect(pushCall(calls).args.at(-2)).toBe('https://github.com/burnjohn/quick-blog.git');
    expect(pushCall(calls).args.join(' ')).not.toContain('evil.example');
    expect(pushCall(calls).env?.['GIT_ALLOW_PROTOCOL']).toBe('https');
  });

  it('puts the token in the child’s environment as a github.com-scoped header, nowhere else', async () => {
    const sha = fx.commit('b.txt');
    const h = publisher();

    await h.publisher.push({ taskId: 'T-1', repo: { owner: 'o', name: 'r' }, sha });

    const { env } = pushCall(h.calls);
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${B64}`,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    });
    for (const call of h.calls) {
      const argv = call.args.join('\n');
      expect(argv).not.toContain(TOKEN);
      expect(argv).not.toContain(B64);
    }
    // Every command except the push runs without a credential at all.
    for (const call of h.calls.filter((c) => !c.args.includes('push'))) {
      expect(JSON.stringify(call.env)).not.toContain(TOKEN);
      expect(JSON.stringify(call.env)).not.toContain(B64);
    }
  });

  it('gives the push child nothing of the engine’s but PATH and HOME', async () => {
    const sha = fx.commit('b.txt');
    const h = publisher();

    await h.publisher.push({ taskId: 'T-1', repo: { owner: 'o', name: 'r' }, sha });

    const env = pushCall(h.calls).env ?? {};
    expect(Object.keys(env).sort()).toEqual(
      [
        'GIT_ALLOW_PROTOCOL',
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_NOSYSTEM',
        'GIT_CONFIG_VALUE_0',
        'GIT_OPTIONAL_LOCKS',
        'GIT_TERMINAL_PROMPT',
        'HOME',
        'PATH',
      ].sort(),
    );
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).not.toHaveProperty('DATABASE_URL');
  });

  it('runs the push in a scratch repository that holds no copy of the token, and removes it', async () => {
    const sha = fx.commit('b.txt');
    let scratch = '';
    const leaks: string[] = [];
    const scan = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) scan(path);
        else {
          const text = readFileSync(path, 'latin1');
          if (text.includes(TOKEN) || text.includes(B64)) leaks.push(path);
        }
      }
    };
    const h = publisher({
      runGit: async (args, options) => {
        const out = await runGit(args, options);
        if (args.includes('push')) {
          scratch = options.cwd;
          scan(options.cwd);
        }
        return out;
      },
    });

    await h.publisher.push({ taskId: 'T-1', repo: { owner: 'o', name: 'r' }, sha });

    expect(scratch).not.toBe('');
    expect(scratch).not.toBe(fx.repo);
    expect(scratch).not.toBe(fx.worktree);
    expect(leaks).toEqual([]);
    expect(() => statSync(dirname(scratch))).toThrow();
  });

  it.each([
    ['a task id', { taskId: 'T-1; rm', sha: 'a'.repeat(40), repo: { owner: 'o', name: 'r' } }],
    ['a sha', { taskId: 'T-1', sha: 'HEAD', repo: { owner: 'o', name: 'r' } }],
    ['a sha that is an option', { taskId: 'T-1', sha: '--force', repo: { owner: 'o', name: 'r' } }],
    ['an owner', { taskId: 'T-1', sha: 'a'.repeat(40), repo: { owner: 'o/..', name: 'r' } }],
    ['a repo name', { taskId: 'T-1', sha: 'a'.repeat(40), repo: { owner: 'o', name: '..' } }],
    [
      'a repo name with a slash',
      { taskId: 'T-1', sha: 'a'.repeat(40), repo: { owner: 'o', name: 'r/x' } },
    ],
  ])('refuses %s that is not what it should be', async (_label, input) => {
    const h = publisher();

    await expect(h.publisher.push(input)).rejects.toThrow(/Invalid/);
    expect(h.calls.some((c) => c.args.includes('push'))).toBe(false);
  });
});

describe('GitBranchPublisher.push: failures', () => {
  const failing = (stderr: string) =>
    publisher({
      runGit: (args, options) =>
        args.includes('push')
          ? Promise.reject(new GitError(args, 1, stderr))
          : runGit(args, options),
    }).publisher;
  const input = () => ({ taskId: 'T-1', repo: { owner: 'o', name: 'r' }, sha: fx.commit('b.txt') });

  it.each([
    [' ! [rejected]        abc -> jarvis/T-1 (non-fast-forward)'],
    [' ! [remote rejected] abc -> jarvis/T-1 (protected branch hook declined)'],
    ['remote: Permission to o/r.git denied to bot.\nfatal: unable to access'],
    ['fatal: Authentication failed for https://github.com/o/r.git/'],
  ])('maps a refusal by the host to "rejected" (%s)', async (stderr) => {
    const result = await failing(stderr).push(input());

    expect(result).toMatchObject({ ok: false, reason: 'rejected' });
  });

  it.each([
    ['fatal: unable to access: Could not resolve host: github.com'],
    ['fatal: unable to access: Failed to connect to github.com port 443'],
    ['error: RPC failed; curl 18 transfer closed'],
  ])('maps a network failure to "unreachable" (%s)', async (stderr) => {
    const result = await failing(stderr).push(input());

    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('never lets the token — raw, URL-encoded or as the header value — into the detail', async () => {
    const stderr = `fatal: bad ${TOKEN} and ${encodeURIComponent(TOKEN)} and AUTHORIZATION: basic ${B64}`;

    const result = await failing(stderr).push(input());

    if (result.ok) throw new Error('expected a failure');
    expect(result.detail).not.toContain(TOKEN);
    expect(result.detail).not.toContain(B64);
    expect(result.detail).toContain('[redacted]');
  });

  it('does not leave the scratch repository behind when the push fails', async () => {
    let scratch = '';
    const p = publisher({
      runGit: (args, options) => {
        if (args.includes('push')) {
          scratch = options.cwd;
          return Promise.reject(new GitError(args, 1, 'fatal: Could not resolve host'));
        }
        return runGit(args, options);
      },
    }).publisher;

    await p.push(input());

    expect(scratch).not.toBe('');
    expect(() => statSync(dirname(scratch))).toThrow();
  });
});
