// ADR-0021 on real parts (ADR-0011): a worker notes an insight through the real HTTP tool route, the
// engine writes it into a temp USER.md, and a later task on the same repository is told about it in
// its first message. The fake `claude` plays the model; nothing here runs the real one.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ThreadDetailDtoSchema } from '@jarvis/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContainer, type Container } from '../../src/container.js';
import { createPool, migrate } from '../../src/infrastructure/db/index.js';
import { resetDatabase, testDatabaseUrl } from '../db.js';

const FAKE_CLAUDE = fileURLToPath(new URL('../fake-claude/fake-claude.mjs', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

let root: string;
let home: string;
let container: Container;
let url: string;

async function waitFor<T>(
  what: string,
  read: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function startThread(text: string): Promise<string> {
  const res = await fetch(`${url}/api/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return ThreadDetailDtoSchema.parse(await res.json()).id;
}

/** The first message the engine sent to a task's worker, as the fake `claude` saved it. */
const firstMessage = (taskId: string) =>
  waitFor(`the first message of ${taskId}`, () => {
    const file = join(home, 'tasks', taskId, 'first-message.txt');
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'jarvis-memory-'));
  home = join(root, 'home');
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 'flow@example.com');
  git(repo, 'config', 'user.name', 'Flow');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'AGENTS.md'), '# Repo\n\n- Test: `pnpm test`\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  // The engine names an agent entry's repository after the `origin` GitHub remote it sees at start-up.
  git(repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git');
  execFileSync('mkdir', ['-p', home]);
  writeFileSync(
    join(home, 'jarvis.config.json'),
    JSON.stringify({
      repo: { path: repo, remote: 'origin', baseBranch: 'main' },
      engine: { claudeBinary: FAKE_CLAUDE },
      // The fake worker brings up no real project: keep these flows off Docker.
      ui: { enabled: false },
    }),
  );
  // The owner's own text, which the engine must leave byte for byte.
  writeFileSync(join(home, 'USER.md'), '# Me\n\nReply in Ukrainian.\n');

  const pool = createPool(testDatabaseUrl());
  await migrate(pool);
  await resetDatabase(pool);
  await pool.end();

  container = await createContainer({
    env: {
      DATABASE_URL: testDatabaseUrl(),
      JARVIS_HOME: home,
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      JARVIS_LOG_LEVEL: 'warn',
    },
    port: 0,
    runnerEnv: { JARVIS_FAKE_SCENARIO: 'memory' },
  });
  // Fetching must not reach GitHub: point the remote at the repository itself once the engine has read it.
  git(repo, 'remote', 'set-url', 'origin', repo);
  url = await container.listen();
}, 30_000);

afterAll(async () => {
  await container?.close();
  const pool = createPool(testDatabaseUrl());
  await resetDatabase(pool);
  await pool.end();
  rmSync(root, { recursive: true, force: true });
});

describe('memory across tasks, with the fake claude', () => {
  it('a worker notes an insight; a later task on the same repository is told about it', async () => {
    await startThread('First task');
    const first = await firstMessage('T-1');
    expect(first).not.toContain('## Memory');

    const user = await waitFor('the entry in USER.md', () => {
      const text = readFileSync(join(home, 'USER.md'), 'utf8');
      return text.includes('pnpm test') ? text : undefined;
    });
    expect(user.startsWith('# Me\n\nReply in Ukrainian.\n')).toBe(true);
    expect(user).toMatch(
      /- m1 \[agent · T-1 · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · ✓1 ✗0\] When running the checks, use pnpm test\. \(src: AGENTS\.md:3\)/,
    );
    expect(user).toContain('### example/repo');
    // The second note cited a file that is not in the worktree: refused, nothing written.
    expect(user).not.toContain('is not there');

    await startThread('Second task');
    const second = await firstMessage('T-2');
    expect(second).toContain('## Owner preferences (USER.md)\n# Me\n\nReply in Ukrainian.');
    expect(second).toContain('## Memory\n');
    expect(second).toContain('- m1 [agent · T-1');
    expect(second).not.toContain('## Learned');
    expect(second).not.toContain('citation missing');
  }, 30_000);
});
