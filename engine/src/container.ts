// Composition root (ADR-0003): the only place adapters are constructed and wired to the application.
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { JarvisConfig } from '@jarvis/shared';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import {
  createApplication,
  type Application,
  type CodeHost,
  type ConfigStatus,
} from './application/index.js';
import { FileArtifactStore } from './infrastructure/artifacts/file-artifact-store.js';
import { HttpHeartbeat } from './infrastructure/heartbeat/http-heartbeat.js';
import { buildChildEnv } from './infrastructure/claude/child-env.js';
import { ClaudeCliRunner } from './infrastructure/claude/index.js';
import type { RunSpec } from './application/index.js';
import { SystemClock } from './infrastructure/clock/system-clock.js';
import {
  createRedactor,
  ensureHome,
  FileConfigProvider,
  jarvisHome,
  loadEnv,
  readEngineVersion,
  StartupError,
  type EnvSource,
  type JarvisEnv,
} from './infrastructure/config/index.js';
import { createConnectionChecks, execFileWith } from './infrastructure/connections/index.js';
import {
  createDatabase,
  createPool,
  migrate,
  PgDatabasePing,
  PgUnitOfWork,
} from './infrastructure/db/index.js';
import { runGit } from './infrastructure/git/run-git.js';
import { GitWorktreeManager } from './infrastructure/git/git-worktree-manager.js';
import { CodeHostError, GitHubCodeHost, parseRemote } from './infrastructure/github/index.js';
import { CryptoIdGenerator } from './infrastructure/ids/crypto-id-generator.js';
import { ConsoleLogger } from './infrastructure/logging/console-logger.js';
import { FileProfileFiles } from './infrastructure/profile/file-profile-files.js';
import { FileProfileStore } from './infrastructure/profile/file-profile-store.js';
import { AgentsMdRepoInfo } from './infrastructure/repo/agents-md-repo-info.js';
import { SseHub } from './infrastructure/sse/sse-hub.js';
import { WebOwnerChannel } from './infrastructure/sse/web-owner-channel.js';
import { LOOPBACK_HOST, buildServer } from './presentation/http/server.js';
import type { TimerDeps } from './presentation/timers/index.js';

/** `<repo checkout>/agent`: the Claude Code plugin the runs load (ADR-0011). */
const AGENT_DIR = fileURLToPath(new URL('../../agent', import.meta.url));
const TSX_LOADER = import.meta.resolve('tsx');
const MCP_ENTRY = fileURLToPath(new URL('./presentation/mcp/main.ts', import.meta.url));

const LOGIN_CHECK_TIMEOUT_MS = 10_000;

export interface ContainerOptions {
  /** Where configuration comes from: `process.env` in main.ts, a plain object in tests. */
  readonly env: EnvSource;
  /** Overrides `engine.port`; 0 picks a free port (tests). */
  readonly port?: number;
  /** Added to every `claude` child's environment (tests select a fake scenario this way). */
  readonly runnerEnv?: Readonly<Record<string, string>>;
  readonly logger?: FastifyServerOptions['logger'];
}

export interface Container {
  readonly app: Application;
  readonly server: FastifyInstance;
  /** What main.ts hands to `startTimers` (T13). */
  readonly timerDeps: TimerDeps;
  /** Binds the API to the configured listen host and returns its base URL. Runs started after this call can reach it. */
  listen(): Promise<string>;
  /** Stops accepting requests, then releases the config watcher and the database pool. */
  close(): Promise<void>;
}

/** Refuses to start unless `claude` is logged in with the subscription: otherwise runs would not use it (SEC-05). */
export async function assertSubscriptionLogin(binary: string, env: EnvSource): Promise<void> {
  const exec = execFileWith(buildChildEnv(env, { role: 'dispatcher' }));
  let stdout: string;
  try {
    ({ stdout } = await exec(binary, ['auth', 'status', '--json'], {
      timeoutMs: LOGIN_CHECK_TIMEOUT_MS,
    }));
  } catch (error) {
    throw new StartupError(
      `Cannot run "${binary}" to check the login (${error instanceof Error ? error.message : String(error)}). ` +
        'Install Claude Code, or set engine.claudeBinary in jarvis.config.json.',
    );
  }
  let status: { loggedIn?: unknown; authMethod?: unknown };
  try {
    status = JSON.parse(stdout) as typeof status;
  } catch {
    throw new StartupError(
      `"${binary} auth status --json" did not return JSON. Update Claude Code and try again.`,
    );
  }
  if (status.loggedIn !== true) {
    throw new StartupError(
      'Claude Code is not logged in. Run `claude auth login`, then start again.',
    );
  }
  if (status.authMethod !== 'claude.ai') {
    throw new StartupError(
      `Claude Code is logged in with "${String(status.authMethod)}", not with a Claude subscription, ` +
        'so runs would not use the subscription (SEC-05). Run `claude auth login` and choose your Claude account.',
    );
  }
}

/** What stands in for GitHub when `GITHUB_TOKEN` is not set: asking it anything fails with a readable reason. */
const unconfiguredCodeHost: CodeHost = {
  snapshot: () => Promise.reject(notConfigured()),
  botLogin: () => Promise.reject(notConfigured()),
  rerunFailedChecks: () => Promise.reject(notConfigured()),
};

function notConfigured(): CodeHostError {
  return new CodeHostError('GitHub is not configured: set GITHUB_TOKEN in ~/.jarvis/.env.', null);
}

async function connectDatabase(databaseUrl: string): Promise<ReturnType<typeof createPool>> {
  const pool = createPool(databaseUrl);
  try {
    await migrate(pool);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw new StartupError(
      'Cannot reach Postgres or apply migrations. Start it with `docker compose up -d` and check ' +
        `DATABASE_URL in ~/.jarvis/.env (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  return pool;
}

/** GitHub host for the configured repo, or null when there is no token or the remote is not on GitHub. */
async function createGitHub(
  env: JarvisEnv,
  config: JarvisConfig,
  logger: ConsoleLogger,
): Promise<GitHubCodeHost | null> {
  if (env.githubToken === undefined) return null;
  const { path, remote } = config.repo;
  try {
    const url = await runGit(['remote', 'get-url', remote], { cwd: path });
    const ref = parseRemote(url);
    if (ref !== null) return new GitHubCodeHost({ token: env.githubToken, ...ref });
    logger.warn('repo.remote is not a GitHub repository; CI follow-up is off', { remote });
  } catch {
    logger.warn(`git remote "${remote}" not found in repo.path; CI follow-up is off`, { remote });
  }
  return null;
}

export async function createContainer(options: ContainerOptions): Promise<Container> {
  const env = loadEnv(options.env);
  const home = jarvisHome(env.jarvisHome);
  await ensureHome(home);

  const provider = new FileConfigProvider(home.configFile);
  const config = provider.load();
  if (config.engine.claudeBinary === 'claude') {
    await assertSubscriptionLogin(config.engine.claudeBinary, options.env);
  }

  const redact = createRedactor([
    env.githubToken ?? '',
    env.notionToken ?? '',
    env.heartbeatUrl ?? '',
  ]);
  const logger = new ConsoleLogger({ redact, level: env.logLevel });
  const pool = await connectDatabase(env.databaseUrl);

  const hub = new SseHub();
  const github = await createGitHub(env, config, logger);
  const port = options.port ?? config.engine.port;
  let apiUrl = `http://${LOOPBACK_HOST}:${port}`;

  const runner = new ClaudeCliRunner({
    binary: config.engine.claudeBinary,
    envSource: options.env,
    ...(env.githubToken === undefined ? {} : { githubToken: env.githubToken }),
    ...(options.runnerEnv === undefined ? {} : { extraEnv: options.runnerEnv }),
    redact,
    contextFor: (spec: RunSpec) => {
      const current = provider.current();
      return {
        agentDir: AGENT_DIR,
        runDir: home.runDir(spec.runId),
        config: {
          repo: current.repo,
          allowlist: current.allowlist,
          telemetry: current.telemetry,
        },
        mcpServer: { command: process.execPath, args: ['--import', TSX_LOADER, MCP_ENTRY] },
        apiUrl,
        connectorsFile: home.mcpServersFile,
        connectorSecrets: {
          ...(env.githubToken === undefined ? {} : { GITHUB_TOKEN: env.githubToken }),
          ...(env.notionToken === undefined ? {} : { NOTION_TOKEN: env.notionToken }),
        },
      };
    },
  });

  const configStatus: ConfigStatus = {
    path: () => home.configFile,
    loadedAt: () => provider.loadedAt(),
    lastError: () => provider.lastError(),
  };
  provider.onChange(() => {
    void hub.publish({ type: 'config' });
    void hub.publish({ type: 'overview' });
  });

  const clock = new SystemClock();
  const connections = createConnectionChecks({
    config: provider,
    env: options.env,
    github,
    clock,
  });
  const app = createApplication({
    uow: new PgUnitOfWork(createDatabase(pool)),
    ids: new CryptoIdGenerator(),
    clock,
    logger,
    config: provider,
    worktrees: new GitWorktreeManager({
      repoPath: config.repo.path,
      remote: config.repo.remote,
      baseBranch: config.repo.baseBranch,
      worktreesDir: join(home.root, 'worktrees'),
    }),
    artifacts: new FileArtifactStore(join(home.root, 'tasks')),
    codeHost: github ?? unconfiguredCodeHost,
    runner,
    profile: new FileProfileStore(home.userFile),
    configStatus,
    repoInfo: new AgentsMdRepoInfo(),
    profileFiles: new FileProfileFiles({
      soul: join(AGENT_DIR, 'SOUL.md'),
      user: home.userFile,
    }),
    connections,
    database: new PgDatabasePing(pool),
    version: readEngineVersion(),
    owner: new WebOwnerChannel(hub),
    events: hub,
  });

  const server = buildServer(app, {
    stream: hub,
    redact,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  return {
    app,
    server,
    timerDeps: {
      config: provider,
      onConfigChange: (listener) => provider.onChange(() => listener()),
      logger,
      checks: connections,
      ...(env.heartbeatUrl === undefined ? {} : { heartbeat: new HttpHeartbeat(env.heartbeatUrl) }),
    },
    async listen() {
      try {
        await server.listen({ host: env.listenHost, port });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          throw new StartupError(
            `Port ${port} is already in use. Stop the other process or change engine.port in jarvis.config.json.`,
          );
        }
        throw error;
      }
      const address = server.addresses()[0];
      apiUrl = `http://${LOOPBACK_HOST}:${address?.port ?? port}`;
      return apiUrl;
    },
    async close() {
      await server.close();
      provider.close();
      await pool.end();
    },
  };
}
