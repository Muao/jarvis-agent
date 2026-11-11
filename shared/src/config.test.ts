import { describe, expect, it } from 'vitest';
import example from '../../jarvis.config.example.json';
import {
  JarvisConfigSchema,
  RETIRED_CONFIG_KEYS,
  dropRetiredConfigKeys,
  formatConfigError,
} from './config.js';

describe('jarvis.config.example.json', () => {
  it('parses against the schema and names the remote, not a URL', () => {
    const config = JarvisConfigSchema.parse(example);
    expect(config.repo.remote).toBe('origin');
    expect(config.repo.remote).not.toMatch(/[:/@]/);
  });
});

const minimal = { repo: { path: '/work/repo' } };

describe('JarvisConfigSchema', () => {
  it('fills defaults for a minimal config', () => {
    const config = JarvisConfigSchema.parse(minimal);
    expect(config.repo).toEqual({ path: '/work/repo', remote: 'origin', baseBranch: 'main' });
    expect(config.limits).toEqual({
      maxConcurrentWorkers: 1,
      checkRetries: 3,
      checkTimeoutMinutes: 15,
      ciFixRounds: 2,
      reviewRounds: 3,
      taskTimeoutMinutes: 60,
      maxTurnsPerRun: 60,
      maxBudgetUsdPerRun: 3,
      dailyBudgetTokens: 50_000_000,
      permissionTimeoutMinutes: 30,
      stallMinutes: 10,
      firstProgressUpdateSeconds: 30,
      progressUpdateMinutes: 1,
    });
    expect(config.watch.pollSeconds).toBe(60);
    expect(config.models).toEqual({ dispatcher: 'sonnet', worker: 'sonnet', reviewer: 'sonnet' });
    expect(config.allowlist).toEqual({ githubReviewers: [], autoAllowedCommands: [] });
    expect(config.repos).toEqual({ allow: [], allowOwnerRepos: false, allowSelf: false });
    expect(config.engine).toEqual({ port: 4310, claudeBinary: 'claude' });
    expect(config.memory).toEqual({ softCapChars: 4000, backupsKept: 20 });
    expect(config.telemetry).toEqual({
      enabled: false,
      otlpEndpoint: 'http://127.0.0.1:4318',
      protocol: 'http/protobuf',
    });
  });

  it('keeps telemetry off in the example and accepts a loopback endpoint', () => {
    expect(JarvisConfigSchema.parse(example).telemetry.enabled).toBe(false);
    const config = JarvisConfigSchema.parse({
      ...minimal,
      telemetry: { enabled: true, otlpEndpoint: 'http://localhost:4318' },
    });
    expect(config.telemetry.enabled).toBe(true);
  });

  it.each([
    'https://otlp-gateway.grafana.net/otlp',
    'http://10.0.0.5:4318',
    'http://127.0.0.1@evil.example:4318',
    'ftp://127.0.0.1:4318',
    '127.0.0.1:4318',
    'not a url',
    '',
  ])('refuses telemetry endpoint %j as a path: message line', (otlpEndpoint) => {
    const result = JarvisConfigSchema.safeParse({ ...minimal, telemetry: { otlpEndpoint } });
    if (result.success) throw new Error('expected failure');
    expect(formatConfigError(result.error)).toMatch(/^telemetry\.otlpEndpoint: .+/);
  });

  it('rejects an unknown telemetry protocol and credential-like keys', () => {
    expect(
      JarvisConfigSchema.safeParse({ ...minimal, telemetry: { protocol: 'grpc' } }).success,
    ).toBe(false);
    expect(
      JarvisConfigSchema.safeParse({ ...minimal, telemetry: { headers: 'Authorization=x' } })
        .success,
    ).toBe(false);
  });

  it('keeps explicit values and partial sections', () => {
    const config = JarvisConfigSchema.parse({ ...minimal, limits: { dailyBudgetTokens: 5000 } });
    expect(config.limits.dailyBudgetTokens).toBe(5000);
    expect(config.limits.checkRetries).toBe(3);
  });

  it('parses repos.allow entries and accepts allowOwnerRepos (ADR-0012)', () => {
    const config = JarvisConfigSchema.parse({
      ...minimal,
      repos: { allow: ['owner/name', 'other-owner/other-repo'], allowOwnerRepos: true },
    });
    expect(config.repos).toEqual({
      allow: ['owner/name', 'other-owner/other-repo'],
      allowOwnerRepos: true,
      allowSelf: false,
    });
  });

  it('accepts repos.allowSelf, off by default (ADR-0012)', () => {
    const config = JarvisConfigSchema.parse({ ...minimal, repos: { allowSelf: true } });
    expect(config.repos.allowSelf).toBe(true);
  });

  it('rejects a repos.allow entry that is not "owner/name"', () => {
    const result = JarvisConfigSchema.safeParse({ ...minimal, repos: { allow: ['not-a-slug'] } });
    if (result.success) throw new Error('expected failure');
    expect(formatConfigError(result.error)).toMatch(/^repos\.allow\.0: /);
  });

  it('rejects unknown keys, including token-like ones', () => {
    expect(JarvisConfigSchema.safeParse({ ...minimal, githubToken: 'x' }).success).toBe(false);
    expect(JarvisConfigSchema.safeParse({ ...minimal, limits: { maxTurnsPerRn: 5 } }).success).toBe(
      false,
    );
  });

  it('reports invalid values as readable path: message lines', () => {
    const result = JarvisConfigSchema.safeParse({
      repo: {},
      limits: { maxConcurrentWorkers: 0, dailyBudgetTokens: 'lots' },
      engine: { port: 70000 },
    });
    if (result.success) throw new Error('expected failure');
    const lines = formatConfigError(result.error).split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) expect(line).toMatch(/^[\w.()]+: .+/);
    expect(lines.some((l) => l.startsWith('repo.path: '))).toBe(true);
    expect(lines.some((l) => l.startsWith('limits.maxConcurrentWorkers: '))).toBe(true);
    expect(lines.some((l) => l.startsWith('limits.dailyBudgetTokens: '))).toBe(true);
    expect(lines.some((l) => l.startsWith('engine.port: '))).toBe(true);
  });

  it('turns the ui check on by default: it is a step of the workflow', () => {
    const config = JarvisConfigSchema.parse(minimal);
    expect(config.ui.enabled).toBe(true);
    expect(config.ui.defaultImage).toBe('node:22-bookworm');
    expect(config.ui.maxStartAttempts).toBe(3);
    expect(config.ui.leaseMinutes).toBe(15);
    expect(config.ui.maxScenarios).toBe(8);
    expect(config.ui.attachToPr).toBe(true);
    expect(config.ui.paths).toContain('**/*.tsx');
  });

  it('knows no target-specific ui key (ADR-0026)', () => {
    for (const key of RETIRED_CONFIG_KEYS) {
      const name = key.split('.')[1] as string;
      expect(JarvisConfigSchema.safeParse({ ...minimal, ui: { [name]: 'x' } }).success).toBe(false);
    }
  });

  it('drops retired keys from an older config and names them', () => {
    const raw = {
      ...minimal,
      ui: { enabled: true, devCommand: './run.sh', env: { A: 'b' }, baseUrl: 'http://127.0.0.1:1' },
    };
    expect(dropRetiredConfigKeys(raw)).toEqual(['ui.devCommand', 'ui.baseUrl', 'ui.env']);
    expect(JarvisConfigSchema.parse(raw).ui.enabled).toBe(true);
    expect(dropRetiredConfigKeys(null)).toEqual([]);
  });

  it('drops the retired dollar budget and rejects it in a strict parse', () => {
    const raw = { ...minimal, limits: { dailyBudgetUsd: 20, stallMinutes: 5 } };
    expect(JarvisConfigSchema.safeParse(raw).success).toBe(false);
    expect(dropRetiredConfigKeys(raw)).toEqual(['limits.dailyBudgetUsd']);
    expect(JarvisConfigSchema.parse(raw).limits.dailyBudgetTokens).toBe(50_000_000);
  });

  it('labels root-level problems', () => {
    const result = JarvisConfigSchema.safeParse(null);
    if (result.success) throw new Error('expected failure');
    expect(formatConfigError(result.error)).toMatch(/^\(root\): /);
  });
});

describe('memory block (ADR-0021)', () => {
  it('takes overrides and rejects a non-positive or unknown key', () => {
    const ok = JarvisConfigSchema.parse({
      ...minimal,
      memory: { softCapChars: 100, backupsKept: 3 },
    });
    expect(ok.memory).toEqual({ softCapChars: 100, backupsKept: 3 });
    expect(JarvisConfigSchema.safeParse({ ...minimal, memory: { backupsKept: 0 } }).success).toBe(
      false,
    );
    expect(JarvisConfigSchema.safeParse({ ...minimal, memory: { cap: 1 } }).success).toBe(false);
  });
});
