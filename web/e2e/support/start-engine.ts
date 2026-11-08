// Entry point of the e2e engine (run by Playwright's webServer, under tsx). Playwright starts web servers
// before globalSetup, so the fixtures the engine needs are built here, then the real engine entry is loaded:
// a fresh `jarvis_e2e` database, a temp Jarvis Home and a temp git repo (ADR-0011).
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
  const root = join(tmpdir(), 'jarvis-e2e');
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
      '| app | `pnpm test` | `pnpm typecheck` |',
      '',
      'Dev: `pnpm dev`',
      '',
    ].join('\n'),
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
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
await import(pathToFileURL(join(engineDir, 'src/main.ts')).href);
