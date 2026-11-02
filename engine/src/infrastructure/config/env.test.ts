import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSubscriptionOnly, loadEnv } from './env.js';
import { StartupError } from './startup-error.js';

describe('loadEnv', () => {
  it('defaults the home to ~/.jarvis and maps only known variables', () => {
    const env = loadEnv({ DATABASE_URL: 'postgres://x', OTHER: 'ignored' });
    expect(env).toEqual({ jarvisHome: join(homedir(), '.jarvis'), databaseUrl: 'postgres://x' });
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
      githubToken: 'g',
      notionToken: 'n',
    });
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
