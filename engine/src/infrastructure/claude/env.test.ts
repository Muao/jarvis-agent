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

  it('keeps the subscription login dir but not the parent Claude session', () => {
    const env = buildChildEnv(source, { role: 'worker' });
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/home/o/.claude-personal');
    expect(env).not.toHaveProperty('CLAUDECODE');
    expect(env).not.toHaveProperty('CLAUDE_CODE_SESSION_ID');
  });

  it('strips billing, database and chat secrets (ADR-0004, ADR-0007)', () => {
    const env = buildChildEnv(source, { role: 'worker', githubToken: 'ghp_bot' });
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

  it('gives GH_TOKEN to workers only', () => {
    expect(buildChildEnv(source, { role: 'worker', githubToken: 'ghp_bot' })['GH_TOKEN']).toBe(
      'ghp_bot',
    );
    expect(
      buildChildEnv(source, { role: 'dispatcher', githubToken: 'ghp_bot' }),
    ).not.toHaveProperty('GH_TOKEN');
    expect(buildChildEnv(source, { role: 'worker' })).not.toHaveProperty('GH_TOKEN');
  });

  it('omits allow-listed variables that are not set', () => {
    expect(buildChildEnv({ PATH: '/bin' }, { role: 'worker' })).toEqual({ PATH: '/bin' });
  });
});
