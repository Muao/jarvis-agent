import { ConnectionIdSchema, type ConnectionId } from '@jarvis/shared';
import { describe, expect, it, vi } from 'vitest';
import { FakeClock, StaticConfigProvider } from '../../application/testing/index.js';
import type { ConnectionChecker, GitHubConnectionStatus } from '../github/index.js';
import { createConnectionChecks } from './create-connection-checks.js';
import type { Exec, ExecResult } from './exec.js';
import { ProbedConnectionChecks } from './probed-connection-checks.js';

const ok = (stdout: string, exitCode = 0): ExecResult => ({ stdout, exitCode });

/** A `claude` that answers `--version` and `auth status` with the given texts; `null` makes the call fail. */
function fakeClaude(answers: { version?: string | null; auth?: string | null }): Exec {
  return async (_file, args) => {
    const answer = args[0] === '--version' ? answers.version : answers.auth;
    if (answer === null || answer === undefined) throw new Error('spawn claude ENOENT');
    return ok(answer);
  };
}

const VERSION = 'version 2510152234 (wrapper)\n2.1.309 (Claude Code)\n';
const LOGGED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'owner@example.com',
  orgName: 'Owner Org',
  subscriptionType: 'max',
});

const SENSITIVE = {
  email: 'owner@example.com',
  orgId: 'org-SENSITIVE-ID',
  orgName: 'SENSITIVE Org Name',
} as const;

/** SEC-04: none of the account fields appears anywhere in the outcome; one assertion per field. */
function expectNoAccountData(outcome: unknown): void {
  const text = JSON.stringify(outcome);
  expect(text, 'email leaked').not.toContain(SENSITIVE.email);
  expect(text, 'orgId leaked').not.toContain(SENSITIVE.orgId);
  expect(text, 'orgName leaked').not.toContain(SENSITIVE.orgName);
}

function checks(
  options: {
    exec?: Exec;
    env?: Record<string, string>;
    github?: ConnectionChecker | null;
    config?: StaticConfigProvider;
    timeoutMs?: number;
    now?: string;
  } = {},
) {
  return createConnectionChecks({
    config: options.config ?? new StaticConfigProvider(),
    env: options.env ?? {},
    github: options.github ?? null,
    clock: new FakeClock(options.now),
    exec: options.exec ?? fakeClaude({ version: VERSION, auth: LOGGED_IN }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

describe('Claude CLI check', () => {
  it('reports the version and the subscription login without the account', async () => {
    const outcome = await checks().check('claude');

    expect(outcome).toEqual({
      status: 'ok',
      summary: 'Logged in · Max',
      subscription: true,
      details: [
        { label: 'Version', value: '2.1.309 (Claude Code)' },
        { label: 'Login', value: 'claude.ai' },
        { label: 'Plan', value: 'Max' },
      ],
    });
    expect(JSON.stringify(outcome)).not.toContain('owner@example.com');
  });

  it('runs the configured binary with read-only subcommands only', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (file, args) => {
      calls.push([file, ...args]);
      return ok(args[0] === '--version' ? VERSION : LOGGED_IN);
    };
    const config = new StaticConfigProvider();
    config.set({ ...config.current(), engine: { port: 4310, claudeBinary: '/opt/claude' } });

    await checks({ exec, config }).check('claude');

    expect(calls).toEqual([
      ['/opt/claude', '--version'],
      ['/opt/claude', 'auth', 'status', '--json'],
    ]);
  });

  it('fails with the login hint when nobody is logged in', async () => {
    const auth = JSON.stringify({ loggedIn: false });
    const outcome = await checks({ exec: fakeClaude({ version: VERSION, auth }) }).check('claude');

    expect(outcome).toMatchObject({
      status: 'failed',
      summary: 'Not logged in. Run `claude auth login`.',
    });
  });

  describe('login expiry', () => {
    const NOW = '2026-11-01T00:00:00.000Z';
    const at = (iso: string) =>
      checks({
        now: NOW,
        exec: fakeClaude({
          version: VERSION,
          auth: JSON.stringify({
            loggedIn: true,
            authMethod: 'claude.ai',
            ...SENSITIVE,
            subscriptionType: 'max',
            loginExpiresAt: iso,
          }),
        }),
      }).check('claude');

    it('fails with the login hint once the login has expired', async () => {
      const outcome = await at('2026-10-31T23:59:59.000Z');

      expect(outcome.status).toBe('failed');
      expect(outcome.summary).toBe('Login expired on 2026-10-31. Run `claude` and /login.');
      expectNoAccountData(outcome);
    });

    it('fails at the exact expiry instant', async () => {
      expect((await at(NOW)).status).toBe('failed');
    });

    it('warns just under 7 days before the expiry', async () => {
      const outcome = await at('2026-11-07T23:59:59.000Z');

      expect(outcome).toMatchObject({ status: 'warning', summary: 'Login expires in 6 days' });
      expectNoAccountData(outcome);
    });

    it('is ok from 7 days before the expiry and shows the date', async () => {
      const outcome = await at('2026-11-08T00:00:00.000Z');

      expect(outcome.status).toBe('ok');
      expect(outcome.summary).toBe('Logged in · Max');
      expect(outcome.details).toContainEqual({ label: 'Expires', value: '2026-11-08' });
    });

    it('stays ok with a comfortable expiry and leaks no account data', async () => {
      const outcome = await at('2027-03-01T00:00:00.000Z');

      expect(outcome.status).toBe('ok');
      expectNoAccountData(outcome);
    });

    it('says 1 day when less than two days remain', async () => {
      expect((await at('2026-11-01T12:00:00.000Z')).summary).toBe('Login expires in 1 day');
    });

    it.each(['not a date', '', 42])('stays ok when the expiry is unusable (%s)', async (value) => {
      const outcome = await at(value as string);

      expect(outcome.status).toBe('ok');
    });
  });

  it('fails when the binary cannot run', async () => {
    const outcome = await checks({ exec: fakeClaude({ version: null }) }).check('claude');

    expect(outcome).toMatchObject({ status: 'failed' });
    expect(outcome.summary).toContain('Cannot run "claude"');
  });

  it('stays ok when this CLI version cannot report the login state', async () => {
    const outcome = await checks({ exec: fakeClaude({ version: VERSION, auth: null }) }).check(
      'claude',
    );

    expect(outcome).toMatchObject({ status: 'ok', details: [{ label: 'Version' }] });
  });

  it('fails when the login is not the subscription', async () => {
    const auth = JSON.stringify({ loggedIn: true, authMethod: 'api_key' });
    const outcome = await checks({ exec: fakeClaude({ version: VERSION, auth }) }).check('claude');

    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('billed to the API');
    expect(outcome.subscription).toBe(false);
  });

  it('fails and names the variable, never its value, when an API billing variable is set (SEC-05)', async () => {
    const connections = checks({ env: { ANTHROPIC_API_KEY: 'sk-ant-secret' } });

    const outcome = await connections.check('claude');

    expect(connections.billingEnvDetected()).toBe(true);
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('ANTHROPIC_API_KEY is set');
    expect(JSON.stringify(outcome)).not.toContain('sk-ant-secret');
    expect(checks().billingEnvDetected()).toBe(false);
  });
});

describe('GitHub check', () => {
  const status: GitHubConnectionStatus = {
    login: 'jarvis-bot',
    repoAccess: true,
    permissions: ['contents', 'pull_requests'],
    expiresAt: null,
  };

  it('is not configured without a token', async () => {
    expect(await checks().check('github')).toMatchObject({ status: 'not_configured' });
  });

  it('shows the account, repository access, permissions and expiry', async () => {
    const github: ConnectionChecker = { checkConnection: async () => status };

    expect(await checks({ github }).check('github')).toEqual({
      status: 'ok',
      summary: 'Connected as jarvis-bot',
      details: [
        { label: 'Account', value: 'jarvis-bot' },
        { label: 'Repository access', value: 'yes' },
        { label: 'Permissions', value: 'contents, pull_requests' },
        { label: 'Token expires', value: 'never' },
      ],
    });
  });

  it('fails when the token cannot reach the repository', async () => {
    const github: ConnectionChecker = {
      checkConnection: async () => ({ ...status, repoAccess: false, permissions: [] }),
    };

    const outcome = await checks({ github }).check('github');

    expect(outcome.status).toBe('failed');
    expect(outcome.details).toContainEqual({ label: 'Permissions', value: 'unknown' });
  });

  it('turns a failing host into a reason, not a throw', async () => {
    const github: ConnectionChecker = {
      checkConnection: async () => {
        throw new Error('GitHub request failed: Bad credentials\nstack...');
      },
    };

    expect(await checks({ github }).check('github')).toEqual({
      status: 'failed',
      summary: 'Check failed: GitHub request failed: Bad credentials',
      details: [],
    });
  });
});

describe('Notion, Google Docs, Claude Design and Slack', () => {
  const withConnectors = (connectors: { notionRoot?: string; googleFolder?: string }) => {
    const config = new StaticConfigProvider();
    config.set({ ...config.current(), connectors });
    return config;
  };

  it('are not configured by default; Slack is disabled', async () => {
    const connections = checks();

    expect(await connections.check('notion')).toMatchObject({
      status: 'not_configured',
      summary: 'Not configured: NOTION_TOKEN, connectors.notionRoot.',
    });
    expect(await connections.check('google_docs')).toMatchObject({
      status: 'not_configured',
      summary: 'Not configured: connectors.googleFolder.',
    });
    expect(await connections.check('claude_design')).toMatchObject({ status: 'not_configured' });
    expect(await connections.check('slack')).toEqual({
      status: 'disabled',
      summary: 'Iteration 2.',
      details: [],
    });
  });

  it('are configured when the token and the link are set, without showing the token', async () => {
    const connections = checks({
      env: { NOTION_TOKEN: 'ntn_secret' },
      config: withConnectors({ notionRoot: 'https://notion.so/root', googleFolder: 'folder-1' }),
    });

    const notion = await connections.check('notion');
    expect(notion).toMatchObject({
      status: 'ok',
      details: [{ label: 'Root page', value: 'https://notion.so/root' }],
    });
    expect(JSON.stringify(notion)).not.toContain('ntn_secret');
    expect(await connections.check('google_docs')).toMatchObject({
      status: 'ok',
      details: [{ label: 'Folder', value: 'folder-1' }],
    });
  });

  it('say what is missing when only part is set', async () => {
    const connections = checks({
      config: withConnectors({ notionRoot: 'https://notion.so/root' }),
    });

    expect((await connections.check('notion')).summary).toBe('Not configured: NOTION_TOKEN.');
  });
});

describe('ProbedConnectionChecks', () => {
  const unused = async () => ({ status: 'ok' as const, summary: 'ok', details: [] });
  const probes = (over: Partial<Record<ConnectionId, () => ReturnType<typeof unused>>>) =>
    Object.fromEntries(ConnectionIdSchema.options.map((id) => [id, over[id] ?? unused])) as Record<
      ConnectionId,
      () => ReturnType<typeof unused>
    >;

  it('reports a probe that never answers as failed once its time is up', async () => {
    vi.useFakeTimers();
    try {
      const connections = new ProbedConnectionChecks({
        probes: probes({ github: () => new Promise(() => undefined) }),
        billingEnvDetected: () => false,
        timeoutMs: 500,
      });

      const pending = connections.check('github');
      await vi.advanceTimersByTimeAsync(500);

      expect(await pending).toEqual({
        status: 'failed',
        summary: 'Check failed: no answer within 500 ms',
        details: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no timer behind after a quick answer', async () => {
    vi.useFakeTimers();
    try {
      const connections = new ProbedConnectionChecks({
        probes: probes({}),
        billingEnvDetected: () => false,
      });

      expect(await connections.check('slack')).toMatchObject({ status: 'ok' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
