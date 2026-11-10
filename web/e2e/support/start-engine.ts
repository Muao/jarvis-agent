// Entry point of the e2e engine (run by Playwright's webServer, under tsx). Playwright starts web servers
// before globalSetup, so the fixtures the engine needs are built here, then the real engine entry is loaded:
// a fresh `jarvis_e2e` database, a temp Jarvis Home and a temp git repo with a local bare `origin` (ADR-0011).
// The engine opens the pull request itself (ADR-0022), so this file also composes it: like `main.ts`, but with a
// fake code host and a push to that bare repository instead of GitHub.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const engineDir = resolve(here, '../../../engine');
const FAKE_CLAUDE = join(here, 'claude-e2e.mjs');

export const E2E_PORT = 4310;
const ROOT = join(tmpdir(), 'jarvis-e2e');
// `git@github.com:example/repo.git` is served by `ssh/example/repo.git` (see freshHome).
const BARE = join(ROOT, 'ssh', 'example', 'repo.git');
const GITHUB_URL = 'git@github.com:example/repo.git';
const ADMIN_URL = 'postgres://jarvis:jarvis@127.0.0.1:5433/postgres';
const E2E_URL = 'postgres://jarvis:jarvis@127.0.0.1:5433/jarvis_e2e';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

async function freshDatabase(): Promise<void> {
  // `pg` is an engine dependency; web has no manifest entry for it (manifests are frozen).
  interface AdminClient {
    connect(): Promise<void>;
    query(sql: string): Promise<unknown>;
    end(): Promise<void>;
  }
  const { Client } = createRequire(join(engineDir, 'package.json'))('pg') as {
    Client: new (options: { connectionString: string }) => AdminClient;
  };
  const client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    await client.query('drop database if exists jarvis_e2e with (force)');
    await client.query('create database jarvis_e2e');
  } finally {
    await client.end();
  }
}

function freshHome(): string {
  const root = ROOT;
  rmSync(root, { recursive: true, force: true });
  const home = join(root, 'home');
  const repo = join(root, 'repo');
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 'e2e@example.com');
  git(repo, 'config', 'user.name', 'E2E');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(
    join(repo, 'AGENTS.md'),
    [
      '# Repo',
      '',
      '| Module | Test command | Typecheck command |',
      '| --- | --- | --- |',
      '| app | `node -e "process.exit(0)"` | `node -e "process.exit(0)"` |',
      '',
      'Dev: `pnpm dev`',
      '',
    ].join('\n'),
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  // A bare repository is the engine's `origin`. The URL looks like a GitHub repository (the engine derives owner
  // and name from it); the "ssh" git runs for it is a script that serves the bare repository, never a connection.
  mkdirSync(dirname(BARE), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', repo, BARE]);
  git(repo, 'remote', 'add', 'origin', GITHUB_URL);
  const fakeSsh = join(ROOT, 'fake-ssh.sh');
  writeFileSync(fakeSsh, `#!/bin/sh\ncd "${join(ROOT, 'ssh')}" && exec sh -c "$2"\n`, {
    mode: 0o755,
  });
  git(repo, 'config', 'core.sshCommand', fakeSsh);
  git(repo, 'fetch', '-q', 'origin');
  writeFileSync(
    join(home, 'jarvis.config.json'),
    JSON.stringify({
      repo: { path: repo, remote: 'origin', baseBranch: 'main' },
      engine: { claudeBinary: FAKE_CLAUDE, port: E2E_PORT },
      watch: { pollSeconds: 3600 },
    }),
  );
  return home;
}

await freshDatabase();
process.env['JARVIS_HOME'] = freshHome();
process.env['DATABASE_URL'] = E2E_URL;

// The engine is loaded at run time only. Its modules are described here by the few members this
// script uses, so the web typecheck does not pull the engine's sources into a DOM-typed program.
interface EngineContainer {
  readonly app: { readonly resumeAfterRestart: { execute(): Promise<unknown> } };
  readonly timerDeps: unknown;
  listen(): Promise<string>;
  close(): Promise<void>;
}
interface EngineCodeHost {
  createPullRequestResult: unknown;
}
const engine = (name: string) => pathToFileURL(join(engineDir, 'src', name)).href;
const { createContainer } = (await import(engine('container.ts'))) as {
  createContainer(options: Record<string, unknown>): Promise<EngineContainer>;
};
const { startTimers } = (await import(engine('presentation/timers/index.ts'))) as {
  startTimers(app: unknown, deps: unknown): { stop(): Promise<void> };
};
const { FakeCodeHost } = (await import(engine('application/testing/fake-code-host.ts'))) as {
  FakeCodeHost: new () => EngineCodeHost;
};

// The fake host answers `createPullRequest` with PR #7; the real engine then pushes `jarvis/<task>` to BARE.
const codeHost = new FakeCodeHost();
codeHost.createPullRequestResult = {
  ok: true,
  number: 7,
  url: 'https://github.com/example/repo/pull/7',
  created: true,
};
const container = await createContainer({
  env: process.env,
  logger: { level: 'warn' },
  codeHost,
  publisherRemoteUrl: () => `file://${BARE}`,
});
const url = await container.listen();
await container.app.resumeAfterRestart.execute();
const timers = startTimers(container.app, container.timerDeps);
process.stdout.write(`Jarvis engine listening on ${url}\n`);

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void timers
    .stop()
    .then(() => container.close())
    .finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
