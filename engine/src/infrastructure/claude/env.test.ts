import type { TaskKind } from '@jarvis/shared';
import { describe, expect, it } from 'vitest';
import { buildChildEnv } from './child-env.js';

const source = {
  PATH: '/usr/bin',
  HOME: '/home/o',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  TERM: 'xterm',
  USER: 'o',
  SHELL: '/bin/zsh',
  TMPDIR: '/tmp',
  CLAUDE_CONFIG_DIR: '/home/o/.claude-personal',
  PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'parent-session',
  ANTHROPIC_API_KEY: 'sk-ant-1',
  ANTHROPIC_AUTH_TOKEN: 'tok',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  DATABASE_URL: 'postgres://x',
  SLACK_BOT_TOKEN: 'xoxb-1',
  GITHUB_TOKEN: 'ghp_raw',
  NOTION_TOKEN: 'ntn',
};

describe('buildChildEnv', () => {
  it('keeps only the allow-list', () => {
    const env = buildChildEnv(source, { role: 'dispatcher' });
    expect(Object.keys(env).sort()).toEqual(
      [
        'CLAUDE_CONFIG_DIR',
        'PLAYWRIGHT_BROWSERS_PATH',
        'HOME',
        'LANG',
        'LC_ALL',
        'PATH',
        'SHELL',
        'TERM',
        'TMPDIR',
        'USER',
      ].sort(),
    );
  });

  it('passes the Playwright browsers path through to the MCP grandchild (ADR-0014)', () => {
    expect(buildChildEnv(source, { role: 'worker' })['PLAYWRIGHT_BROWSERS_PATH']).toBe(
      '/ms-playwright',
    );
  });

  it('keeps the subscription login dir but not the parent Claude session', () => {
    const env = buildChildEnv(source, { role: 'worker' });
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/home/o/.claude-personal');
    expect(env).not.toHaveProperty('CLAUDECODE');
    expect(env).not.toHaveProperty('CLAUDE_CODE_SESSION_ID');
  });

  it('strips billing, database and chat secrets (ADR-0003, ADR-0015)', () => {
    const env = buildChildEnv(source, { role: 'worker' });
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'DATABASE_URL',
      'SLACK_BOT_TOKEN',
      'GITHUB_TOKEN',
      'NOTION_TOKEN',
    ]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  // ADR-0022: a property over every role/kind, not one case.
  it('no run of any role or task kind has a GitHub token in its environment', () => {
    const tokenSource = {
      ...source,
      GH_TOKEN: 'fake-token-a',
      GITHUB_TOKEN: 'fake-token-b',
      GH_ENTERPRISE_TOKEN: 'fake-token-c',
      GITHUB_ENTERPRISE_TOKEN: 'fake-token-d',
    };
    const kinds: Array<TaskKind | undefined> = [undefined, 'build', 'ui_check'];
    for (const role of ['worker', 'dispatcher'] as const) {
      for (const taskKind of kinds) {
        for (const runDir of [undefined, '/runs/R-1']) {
          const env = buildChildEnv(tokenSource, {
            role,
            ...(taskKind === undefined ? {} : { taskKind }),
            ...(runDir === undefined ? {} : { runDir }),
          });
          for (const name of Object.keys(env))
            expect(name).not.toMatch(/TOKEN|GITHUB|^GH_(?!CONFIG_DIR$)/);
          expect(Object.values(env).join('\n')).not.toMatch(/fake-token-/);
        }
      }
    }
  });

  it('a worker gets the git/gh hardening variables, the dispatcher does not (ADR-0022)', () => {
    for (const taskKind of ['build', 'ui_check'] as const) {
      const env = buildChildEnv(source, { role: 'worker', taskKind, runDir: '/runs/R-1' });
      expect(env['GH_CONFIG_DIR']).toBe('/runs/R-1/gh');
      expect(env['GIT_CONFIG_GLOBAL']).toBe('/dev/null');
      expect(env['GIT_CONFIG_NOSYSTEM']).toBe('1');
      expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    }
    const dispatcher = buildChildEnv(source, { role: 'dispatcher', runDir: '/runs/R-1' });
    for (const name of [
      'GH_CONFIG_DIR',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_NOSYSTEM',
      'GIT_TERMINAL_PROMPT',
    ]) {
      expect(dispatcher).not.toHaveProperty(name);
    }
  });

  it('omits allow-listed variables that are not set', () => {
    expect(buildChildEnv({ PATH: '/bin' }, { role: 'dispatcher' })).toEqual({ PATH: '/bin' });
  });

  describe('telemetry (ADR-0016)', () => {
    const telemetry = {
      enabled: true,
      otlpEndpoint: 'http://127.0.0.1:4318',
      protocol: 'http/protobuf',
      runId: 'R-1',
      sessionId: 'S-1',
      taskId: 'T-1',
    };
    const noisy = {
      ...source,
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic secret',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://grafana.example',
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    };
    const telemetryKeys = (env: Record<string, string>) =>
      Object.keys(env).filter((k) => k.startsWith('OTEL_') || k === 'CLAUDE_CODE_ENABLE_TELEMETRY');

    it('disabled: not one OTEL_* or enable key exists, even if the engine has them', () => {
      expect(telemetryKeys(buildChildEnv(noisy, { role: 'worker' }))).toEqual([]);
      expect(
        telemetryKeys(
          buildChildEnv(noisy, { role: 'worker', telemetry: { ...telemetry, enabled: false } }),
        ),
      ).toEqual([]);
    });

    it('enabled: sets exactly the documented variables', () => {
      const env = buildChildEnv(source, { role: 'worker', telemetry });
      expect(
        Object.fromEntries(Object.entries(env).filter(([k]) => telemetryKeys(env).includes(k))),
      ).toEqual({
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
        OTEL_LOG_USER_PROMPTS: '0',
        OTEL_RESOURCE_ATTRIBUTES:
          'service.name=jarvis-claude,jarvis.role=worker,jarvis.run_id=R-1,jarvis.task_id=T-1,jarvis.session_id=S-1',
      });
    });

    it('uses - for a run without a task', () => {
      const { enabled, otlpEndpoint, protocol, runId, sessionId } = telemetry;
      const noTask = { enabled, otlpEndpoint, protocol, runId, sessionId };
      const env = buildChildEnv(source, { role: 'dispatcher', telemetry: noTask });
      expect(env['OTEL_RESOURCE_ATTRIBUTES']).toBe(
        'service.name=jarvis-claude,jarvis.role=dispatcher,jarvis.run_id=R-1,jarvis.task_id=-,jarvis.session_id=S-1',
      );
    });

    it('never passes OTEL_EXPORTER_OTLP_HEADERS and does not inherit the engine endpoint', () => {
      const env = buildChildEnv(noisy, { role: 'worker', telemetry });
      expect(env).not.toHaveProperty('OTEL_EXPORTER_OTLP_HEADERS');
      expect(env['OTEL_EXPORTER_OTLP_ENDPOINT']).toBe('http://127.0.0.1:4318');
      expect(Object.values(env).join('\n')).not.toContain('secret');
    });
  });
});
