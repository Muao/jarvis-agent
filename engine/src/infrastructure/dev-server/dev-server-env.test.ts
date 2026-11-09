import { JarvisConfigSchema } from '@jarvis/shared';
import { describe, expect, it } from 'vitest';
import { buildDevServerEnv } from './dev-server-env.js';

const uiWith = (env: Record<string, string> = {}) =>
  JarvisConfigSchema.parse({ repo: { path: '/jarvis/repo' }, ui: { env } }).ui;

/** What a configured engine actually holds, names and all (verified on the running container). */
const ENGINE = {
  PATH: '/usr/bin',
  HOME: '/home/jarvis',
  LANG: 'C.UTF-8',
  TMPDIR: '/tmp',
  GITHUB_TOKEN: 'gho_secret',
  GH_TOKEN: 'gho_secret',
  DATABASE_URL: 'postgres://jarvis:pw@postgres:5432/jarvis',
  INFISICAL_CLIENT_SECRET: 'st_secret',
  CLAUDE_CONFIG_DIR: '/home/jarvis/.claude',
};

describe('the dev server environment (ADR-0018)', () => {
  // `ui.devCommand` opens with `npm ci`, which runs the `postinstall` scripts of a lockfile that
  // may come from a pull request nobody here wrote. It used to get the engine's whole environment.
  it('hands a pull request’s build scripts no credential the engine holds', () => {
    const env = buildDevServerEnv(ENGINE, uiWith());

    for (const leaked of [
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'DATABASE_URL',
      'INFISICAL_CLIENT_SECRET',
      'CLAUDE_CONFIG_DIR',
    ]) {
      expect(env, leaked).not.toHaveProperty(leaked);
    }
    expect(Object.values(env)).not.toContain('gho_secret');
  });

  it('keeps what a build genuinely needs', () => {
    const env = buildDevServerEnv(ENGINE, uiWith());

    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/jarvis',
      LANG: 'C.UTF-8',
      TMPDIR: '/tmp',
    });
  });

  it('adds what the owner declared, so narrowing the list blocks nothing they wanted', () => {
    const env = buildDevServerEnv(
      ENGINE,
      uiWith({ MONGODB_URI: 'mongodb://127.0.0.1:27017/quickblog', PORT: '5001' }),
    );

    expect(env).toMatchObject({
      MONGODB_URI: 'mongodb://127.0.0.1:27017/quickblog',
      PORT: '5001',
      PATH: '/usr/bin',
    });
  });

  // The escape hatch: a project that truly needs a credential says so, and the value still lives
  // in the environment rather than in the config file (ADR-0015).
  it('passes a variable through only when the owner names it', () => {
    const env = buildDevServerEnv(ENGINE, uiWith({ APP_TOKEN: '${GITHUB_TOKEN}' }));

    expect(env['APP_TOKEN']).toBe('gho_secret');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
  });

  it('turns a reference to a variable the engine does not have into an empty value', () => {
    const env = buildDevServerEnv(ENGINE, uiWith({ APP_TOKEN: '${MISSING}' }));

    expect(env['APP_TOKEN']).toBe('');
  });

  it('leaves a value that merely looks like a reference alone', () => {
    const env = buildDevServerEnv(ENGINE, uiWith({ GREETING: 'cost is ${5}' }));

    expect(env['GREETING']).toBe('cost is ${5}');
  });
});
