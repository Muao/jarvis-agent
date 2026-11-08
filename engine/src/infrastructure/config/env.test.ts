import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSubscriptionOnly, loadEnv } from './env.js';
import { StartupError } from './startup-error.js';

describe('loadEnv heartbeat', () => {
  it('leaves heartbeatUrl out when HEARTBEAT_URL is unset or empty', () => {
    expect(loadEnv({ DATABASE_URL: 'p' })).not.toHaveProperty('heartbeatUrl');
    expect(loadEnv({ DATABASE_URL: 'p', HEARTBEAT_URL: '  ' })).not.toHaveProperty('heartbeatUrl');
  });

  it('reads HEARTBEAT_URL', () => {
    const url = 'https://hc-ping.example/ping/abc';
    expect(loadEnv({ DATABASE_URL: 'p', HEARTBEAT_URL: url }).heartbeatUrl).toBe(url);
  });

  it('refuses an invalid URL without echoing the value', () => {
    const run = () => loadEnv({ DATABASE_URL: 'p', HEARTBEAT_URL: 'ftp://secret-token-9' });
    expect(run).toThrow(StartupError);
    expect(run).toThrow(/HEARTBEAT_URL is not a valid http\(s\) URL/);
    expect(run).not.toThrow(/secret-token-9/);
  });
});

describe('loadEnv', () => {
  it('defaults the home to ~/.jarvis and maps only known variables', () => {
    const env = loadEnv({ DATABASE_URL: 'postgres://x', OTHER: 'ignored' });
    expect(env).toEqual({
      jarvisHome: join(homedir(), '.jarvis'),
      databaseUrl: 'postgres://x',
      listenHost: '127.0.0.1',
      logLevel: 'info',
    });
  });

  it('accepts an explicit 127.0.0.1 listen host', () => {
    expect(loadEnv({ DATABASE_URL: 'p', JARVIS_LISTEN_HOST: '127.0.0.1' }).listenHost).toBe(
      '127.0.0.1',
    );
  });

  it('normalizes localhost to 127.0.0.1', () => {
    expect(loadEnv({ DATABASE_URL: 'p', JARVIS_LISTEN_HOST: 'localhost' }).listenHost).toBe(
      '127.0.0.1',
    );
  });

  it('falls back to 127.0.0.1 when JARVIS_LISTEN_HOST is empty', () => {
    expect(loadEnv({ DATABASE_URL: 'p', JARVIS_LISTEN_HOST: '' }).listenHost).toBe('127.0.0.1');
  });

  it.each(['::1', '127.0.0.2', '127.evil.com'])(
    'refuses %s, which 127.0.0.1 would not reach or is a lookalike',
    (host) => {
      const run = () => loadEnv({ DATABASE_URL: 'p', JARVIS_LISTEN_HOST: host });
      expect(run).toThrow(StartupError);
      expect(run).toThrow(/Allowed values are 127\.0\.0\.1 and localhost/);
    },
  );

  it('refuses a non-loopback listen host outside the container', () => {
    const run = () => loadEnv({ DATABASE_URL: 'p', JARVIS_LISTEN_HOST: '0.0.0.0' });
    expect(run).toThrow(StartupError);
    expect(run).toThrow(/Refusing to start.*JARVIS_LISTEN_HOST=0\.0\.0\.0.*ADR-0015.*Unset/s);
  });

  it('refuses a non-loopback listen host when the container flag is not exactly 1', () => {
    const source = {
      DATABASE_URL: 'p',
      JARVIS_LISTEN_HOST: '0.0.0.0',
      JARVIS_INSIDE_CONTAINER: '0',
    };
    expect(() => loadEnv(source)).toThrow(StartupError);
  });

  it('accepts 0.0.0.0 inside the container', () => {
    const env = loadEnv({
      DATABASE_URL: 'p',
      JARVIS_LISTEN_HOST: '0.0.0.0',
      JARVIS_INSIDE_CONTAINER: '1',
    });
    expect(env.listenHost).toBe('0.0.0.0');
  });

  it('honours JARVIS_HOME and optional tokens', () => {
    const env = loadEnv({
      JARVIS_HOME: '/tmp/h',
      DATABASE_URL: 'postgres://x',
      GITHUB_TOKEN: 'g',
      NOTION_TOKEN: 'n',
    });
    expect(env).toEqual({
      jarvisHome: '/tmp/h',
      databaseUrl: 'postgres://x',
      listenHost: '127.0.0.1',
      logLevel: 'info',
      githubToken: 'g',
      notionToken: 'n',
    });
  });

  it.each(['error', 'warn', 'info'] as const)('accepts JARVIS_LOG_LEVEL=%s', (level) => {
    expect(loadEnv({ DATABASE_URL: 'p', JARVIS_LOG_LEVEL: level }).logLevel).toBe(level);
  });

  it('defaults an empty JARVIS_LOG_LEVEL to info', () => {
    expect(loadEnv({ DATABASE_URL: 'p', JARVIS_LOG_LEVEL: '' }).logLevel).toBe('info');
  });

  it('refuses an unknown JARVIS_LOG_LEVEL as a start-up error', () => {
    const run = () => loadEnv({ DATABASE_URL: 'p', JARVIS_LOG_LEVEL: 'debug' });
    expect(run).toThrow(StartupError);
    expect(run).toThrow(/JARVIS_LOG_LEVEL=debug.*error, warn, info/);
  });

  it('treats empty tokens as absent', () => {
    expect(loadEnv({ DATABASE_URL: 'p', GITHUB_TOKEN: '' })).not.toHaveProperty('githubToken');
  });

  it('fails with a StartupError when DATABASE_URL is missing', () => {
    expect(() => loadEnv({})).toThrow(StartupError);
  });
});

describe('assertSubscriptionOnly', () => {
  it('passes on a clean environment', () => {
    expect(() => assertSubscriptionOnly({ PATH: '/bin' })).not.toThrow();
  });

  it.each([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
  ])('refuses to start when %s is set', (name) => {
    const run = () => assertSubscriptionOnly({ [name]: '1' });
    expect(run).toThrow(StartupError);
    expect(run).toThrow(new RegExp(`${name}.*billed to the API.*Unset`, 's'));
  });

  it('never echoes the value', () => {
    expect(() => assertSubscriptionOnly({ ANTHROPIC_API_KEY: 'sk-secret-123' })).not.toThrow(
      /sk-secret/,
    );
  });
});
