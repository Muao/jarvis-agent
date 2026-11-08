import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cloneOnDemand } from './clone-on-demand.js';

describe('cloneOnDemand', () => {
  let root: string;
  let bare: string;
  let reposRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jarvis-clone-'));
    const source = join(root, 'source');
    bare = join(root, 'bare.git');
    reposRoot = join(root, 'repos');
    execFileSync('git', ['init', '-b', 'main', source]);
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: source });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: source });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: source });
    writeFileSync(join(source, 'a.txt'), 'a');
    execFileSync('git', ['add', '.'], { cwd: source });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: source });
    execFileSync('git', ['clone', '--bare', source, bare]);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const ref = { owner: 'owner', repo: 'name' };
  const cloneUrl = () => bare;
  const HELPER_KEY = 'credential.https://github.com.helper';

  it('clones a missing repo into <reposRoot>/<owner>/<name>', async () => {
    const path = await cloneOnDemand(ref, { reposRoot, token: 'secret-token', cloneUrl });
    expect(path).toBe(join(reposRoot, 'owner', 'name'));
    expect(existsSync(join(path, 'a.txt'))).toBe(true);
  });

  it('reuses an existing working tree instead of cloning again', async () => {
    const first = await cloneOnDemand(ref, { reposRoot, token: 'secret-token', cloneUrl });
    writeFileSync(join(first, 'marker.txt'), 'kept');
    const second = await cloneOnDemand(ref, {
      reposRoot,
      token: 'secret-token',
      cloneUrl: () => {
        throw new Error('must not clone again');
      },
    });
    expect(second).toBe(first);
    expect(existsSync(join(second, 'marker.txt'))).toBe(true);
  });

  it('writes no credential into .git/config and installs the env-reading helper (SEC-04)', async () => {
    const token = 'super-secret-token';
    const path = await cloneOnDemand(ref, { reposRoot, token, cloneUrl });

    const config = readFileSync(join(path, '.git', 'config'), 'utf8');
    expect(config).not.toContain(token);
    expect(config).not.toContain('x-access-token:');
    const helper = execFileSync('git', ['config', '--local', '--get', HELPER_KEY], {
      cwd: path,
      encoding: 'utf8',
    });
    expect(helper).toContain('GH_TOKEN');
    expect(helper).not.toContain(token);
  });

  /** What git itself gets back when it asks the stored helper for a github.com credential. */
  function askGitForCredentials(repo: string, env: Record<string, string>): string {
    return execFileSync('git', ['credential', 'fill'], {
      cwd: repo,
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      // Isolate from the developer's own helpers, so only the clone's config can answer.
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GH_TOKEN: '',
        GITHUB_TOKEN: '',
        ...env,
      },
    });
  }

  it('answers git with the token from the environment, and with nothing without one', async () => {
    const path = await cloneOnDemand(ref, { reposRoot, token: 'unused', cloneUrl });

    expect(askGitForCredentials(path, { GH_TOKEN: 'token-from-worker' })).toContain(
      'password=token-from-worker',
    );
    expect(askGitForCredentials(path, { GH_TOKEN: 'token-from-worker' })).toContain(
      'username=x-access-token',
    );
    // The engine's own process carries GITHUB_TOKEN instead of GH_TOKEN.
    expect(askGitForCredentials(path, { GITHUB_TOKEN: 'token-from-engine' })).toContain(
      'password=token-from-engine',
    );
    // No token anywhere: an empty password, so git fails loudly rather than using a stale one.
    expect(askGitForCredentials(path, {})).not.toMatch(/password=.+/);
  });

  it('rewrites a clone made earlier whose remote URL carries the token', async () => {
    const token = 'super-secret-token';
    const path = await cloneOnDemand(ref, { reposRoot, token, cloneUrl });
    // Put the old, leaking remote back, the way the previous version left it on disk.
    const leaking = `https://x-access-token:${token}@github.com/owner/name.git`;
    execFileSync('git', ['remote', 'set-url', 'origin', leaking], { cwd: path });
    execFileSync('git', ['config', '--local', '--unset', HELPER_KEY], { cwd: path });
    expect(readFileSync(join(path, '.git', 'config'), 'utf8')).toContain(token);

    const again = await cloneOnDemand(ref, {
      reposRoot,
      token,
      cloneUrl: () => {
        throw new Error('must not clone again');
      },
    });

    expect(again).toBe(path);
    const config = readFileSync(join(path, '.git', 'config'), 'utf8');
    expect(config).not.toContain(token);
    expect(config).toContain('https://github.com/owner/name.git');
    expect(config).toContain('GH_TOKEN');
  });

  it('never leaks the token in a clone failure', async () => {
    const token = 'super-secret-token';
    await expect(
      cloneOnDemand(ref, {
        reposRoot,
        token,
        cloneUrl: (_ref, t) => `https://x-access-token:${t}@example.invalid/does-not-exist.git`,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return !message.includes(token);
    });
  });
});
