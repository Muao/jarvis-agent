import { createServer, type IncomingMessage, type Server } from 'node:http';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitBranchPublisher } from './git-branch-publisher.js';
import { type Fixture, git, makeFixture } from './git-branch-publisher.fixture.js';

/**
 * ADR-0022's adversary: the worker can write the clone's config. Real git, real repositories, and
 * a real HTTP server standing in for GitHub, because a credential helper or a proxy only matters
 * once git actually asks for credentials or opens a connection.
 */

const TOKEN = 'FAKE-PUSH-TOKEN-0123456789';
const B64 = Buffer.from(`x-access-token:${TOKEN}`, 'utf8').toString('base64');
const REPO = { owner: 'o', name: 'r' };

let fx: Fixture;
let servers: Server[];
beforeEach(async () => {
  fx = await makeFixture();
  servers = [];
});
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  fx.cleanup();
});

const publisher = (remoteUrl: () => string) =>
  new GitBranchPublisher({
    token: TOKEN,
    worktreesDir: fx.worktreesDir,
    baseBranch: 'main',
    remote: 'origin',
    env: { PATH: process.env['PATH'], HOME: process.env['HOME'] },
    remoteUrl,
  });

const fileRemote = () => `file://${fx.bare}`;
const sha = (repo: string, ref: string) => git(repo, 'rev-parse', ref);

/** An HTTP server that records what it is sent, answering 401 to everything (git then asks for credentials). */
async function listen(
  handler: (req: IncomingMessage) => void,
): Promise<{ port: number; requests: IncomingMessage['headers'][] }> {
  const requests: IncomingMessage['headers'][] = [];
  const server = createServer((req, res) => {
    requests.push(req.headers);
    handler(req);
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, requests };
}

/** An executable script that records that it ran, and with which environment. */
function trap(name: string): { path: string; marker: string; dump: string } {
  const dir = join(fx.root, 'traps');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const marker = join(fx.root, `${name}.ran`);
  const dump = join(fx.root, `${name}.env`);
  writeFileSync(path, `#!/bin/sh\necho ran > "${marker}"\nenv > "${dump}"\nexit 0\n`);
  chmodSync(path, 0o755);
  return { path, marker, dump };
}

describe('GitBranchPublisher.push against a bare repository', () => {
  it('pushes the commit to jarvis/<task-id>', async () => {
    const head = fx.commit('b.txt');

    expect(await publisher(fileRemote).push({ taskId: 'T-1', repo: REPO, sha: head })).toEqual({
      ok: true,
    });
    expect(sha(fx.bare, 'refs/heads/jarvis/T-1')).toBe(head);
  });

  it('pushes the exact sha it was given even when the branch has moved on', async () => {
    const ran = fx.commit('b.txt');
    fx.commit('c.txt');

    expect(await publisher(fileRemote).push({ taskId: 'T-1', repo: REPO, sha: ran })).toEqual({
      ok: true,
    });
    expect(sha(fx.bare, 'refs/heads/jarvis/T-1')).toBe(ran);
    expect(sha(fx.worktree, 'HEAD')).not.toBe(ran);
  });

  it('pushes a fast-forward on top of an earlier push', async () => {
    const first = fx.commit('b.txt');
    await publisher(fileRemote).push({ taskId: 'T-1', repo: REPO, sha: first });
    const second = fx.commit('c.txt');

    expect(await publisher(fileRemote).push({ taskId: 'T-1', repo: REPO, sha: second })).toEqual({
      ok: true,
    });
    expect(sha(fx.bare, 'refs/heads/jarvis/T-1')).toBe(second);
  });

  it('refuses a non-fast-forward and leaves the remote branch where it was', async () => {
    const first = fx.commit('b.txt');
    await publisher(fileRemote).push({ taskId: 'T-1', repo: REPO, sha: first });
    // The worker rewrites history: amend the pushed commit.
    git(fx.worktree, 'commit', '-q', '--amend', '-m', 'rewritten');
    const rewritten = sha(fx.worktree, 'HEAD');

    const result = await publisher(fileRemote).push({ taskId: 'T-1', repo: REPO, sha: rewritten });

    expect(result).toMatchObject({ ok: false, reason: 'rejected' });
    expect(sha(fx.bare, 'refs/heads/jarvis/T-1')).toBe(first);
  });

  it('pushes nothing but the one branch (no tags, no other refs)', async () => {
    const head = fx.commit('b.txt');
    git(fx.worktree, 'tag', 'v1');
    git(fx.repo, 'branch', 'other');

    await publisher(fileRemote).push({ taskId: 'T-1', repo: REPO, sha: head });

    expect(git(fx.bare, 'for-each-ref', '--format=%(refname)')).toBe(
      'refs/heads/jarvis/T-1\nrefs/heads/main',
    );
  });

  it('reports a remote that does not exist as a failure, not an exception', async () => {
    const head = fx.commit('b.txt');

    const result = await publisher(() => `file://${join(fx.root, 'nope.git')}`).push({
      taskId: 'T-1',
      repo: REPO,
      sha: head,
    });

    expect(result.ok).toBe(false);
  });
});

describe('GitBranchPublisher.push with a hostile clone config (ADR-0022)', () => {
  it('ignores core.hooksPath, credential.helper, core.sshCommand and url.insteadOf in the clone', async () => {
    const head = fx.commit('b.txt');
    const decoy = join(fx.root, 'decoy.git');
    git(fx.root, 'init', '-q', '--bare', decoy);

    const hook = trap('pre-push');
    const hooks = join(fx.root, 'hooks');
    mkdirSync(hooks);
    for (const name of ['pre-push', 'reference-transaction', 'post-update', 'pre-receive']) {
      writeFileSync(join(hooks, name), readFileSync(hook.path));
      chmodSync(join(hooks, name), 0o755);
    }
    const helper = trap('helper');
    const ssh = trap('ssh');
    const askpass = trap('askpass');
    const fsmonitor = trap('fsmonitor');

    git(fx.repo, 'config', 'core.hooksPath', hooks);
    git(fx.repo, 'config', 'credential.helper', `!${helper.path}`);
    git(fx.repo, 'config', 'core.sshCommand', ssh.path);
    git(fx.repo, 'config', 'core.askPass', askpass.path);
    git(fx.repo, 'config', 'core.fsmonitor', fsmonitor.path);
    git(fx.repo, 'config', `url.file://${decoy}.insteadOf`, `file://${fx.bare}`);
    git(fx.repo, 'config', `url.file://${decoy}.pushInsteadOf`, `file://${fx.bare}`);
    git(fx.repo, 'config', 'remote.origin.pushurl', `file://${decoy}`);

    const pub = publisher(fileRemote);
    // Reading the worktree must not run the fsmonitor either.
    await pub.status('T-1');
    await pub.headSha('T-1');
    const result = await pub.push({ taskId: 'T-1', repo: REPO, sha: head });

    expect(result).toEqual({ ok: true });
    expect(sha(fx.bare, 'refs/heads/jarvis/T-1')).toBe(head);
    expect(existsSync(join(decoy, 'refs', 'heads', 'jarvis'))).toBe(false);
    for (const t of [hook, helper, ssh, askpass, fsmonitor]) {
      expect(existsSync(t.marker), t.path).toBe(false);
      expect(existsSync(t.dump), t.path).toBe(false);
    }
  });

  it('never hands the token to a credential helper, a proxy or a server it does not belong to', async () => {
    const head = fx.commit('b.txt');
    const helper = trap('helper');
    const askpass = trap('askpass');
    const proxy = await listen(() => undefined);
    const target = await listen(() => undefined);
    git(fx.repo, 'config', 'credential.helper', `!${helper.path}`);
    git(fx.repo, 'config', 'core.askPass', askpass.path);
    git(fx.repo, 'config', 'http.proxy', `http://127.0.0.1:${proxy.port}`);
    git(fx.repo, 'config', 'http.sslVerify', 'false');
    git(
      fx.repo,
      'config',
      `http.http://127.0.0.1:${target.port}/.proxy`,
      `http://127.0.0.1:${proxy.port}`,
    );

    // The server answers 401 to everything, so git asks for credentials: the moment a helper or an
    // askpass program would be run, and the moment a token would be sent if it were in scope.
    const result = await publisher(() => `http://127.0.0.1:${target.port}/o/r.git`).push({
      taskId: 'T-1',
      repo: REPO,
      sha: head,
    });

    expect(result.ok).toBe(false);
    expect(target.requests.length).toBeGreaterThan(0);
    expect(proxy.requests).toEqual([]);
    for (const headers of target.requests) {
      expect(JSON.stringify(headers)).not.toContain(B64);
      expect(headers.authorization).toBeUndefined();
    }
    for (const t of [helper, askpass]) {
      expect(existsSync(t.marker), t.path).toBe(false);
      expect(existsSync(t.dump), t.path).toBe(false);
    }
    if (!result.ok) {
      expect(result.detail).not.toContain(TOKEN);
      expect(result.detail).not.toContain(B64);
    }
  });

  it('reads nothing the worker put in the global git config either', async () => {
    const head = fx.commit('b.txt');
    const helper = trap('home-helper');
    const home = join(fx.root, 'home');
    mkdirSync(home);
    writeFileSync(
      join(home, '.gitconfig'),
      `[core]\n\thooksPath = ${join(fx.root, 'hooks')}\n[credential]\n\thelper = !${helper.path}\n`,
    );
    const pub = new GitBranchPublisher({
      token: TOKEN,
      worktreesDir: fx.worktreesDir,
      baseBranch: 'main',
      remote: 'origin',
      env: { PATH: process.env['PATH'], HOME: home },
      remoteUrl: fileRemote,
    });

    expect(await pub.push({ taskId: 'T-1', repo: REPO, sha: head })).toEqual({ ok: true });
    expect(existsSync(helper.marker)).toBe(false);
  });
});
