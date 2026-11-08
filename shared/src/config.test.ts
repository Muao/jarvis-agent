import { describe, expect, it } from 'vitest';
import example from '../../jarvis.config.example.json';
import { JarvisConfigSchema, formatConfigError } from './config.js';

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
      ciFixRounds: 2,
      reviewRounds: 3,
      taskTimeoutMinutes: 60,
      maxTurnsPerRun: 60,
      maxBudgetUsdPerRun: 3,
      dailyBudgetUsd: 20,
      permissionTimeoutMinutes: 30,
      stallMinutes: 10,
      progressUpdateMinutes: 2,
    });
    expect(config.watch.pollSeconds).toBe(60);
    expect(config.models).toEqual({ dispatcher: 'sonnet', worker: 'sonnet', reviewer: 'sonnet' });
    expect(config.allowlist).toEqual({ githubReviewers: [], autoAllowedCommands: [] });
    expect(config.repos).toEqual({ allow: [], allowOwnerRepos: false });
    expect(config.engine).toEqual({ port: 4310, claudeBinary: 'claude' });
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
    const config = JarvisConfigSchema.parse({ ...minimal, limits: { dailyBudgetUsd: 5 } });
    expect(config.limits.dailyBudgetUsd).toBe(5);
    expect(config.limits.checkRetries).toBe(3);
  });

  it('parses repos.allow entries and accepts allowOwnerRepos (ADR-0019)', () => {
    const config = JarvisConfigSchema.parse({
      ...minimal,
      repos: { allow: ['owner/name', 'other-owner/other-repo'], allowOwnerRepos: true },
    });
    expect(config.repos).toEqual({
      allow: ['owner/name', 'other-owner/other-repo'],
      allowOwnerRepos: true,
    });
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
      limits: { maxConcurrentWorkers: 0, dailyBudgetUsd: 'lots' },
      engine: { port: 70000 },
    });
    if (result.success) throw new Error('expected failure');
    const lines = formatConfigError(result.error).split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) expect(line).toMatch(/^[\w.()]+: .+/);
    expect(lines.some((l) => l.startsWith('repo.path: '))).toBe(true);
    expect(lines.some((l) => l.startsWith('limits.maxConcurrentWorkers: '))).toBe(true);
    expect(lines.some((l) => l.startsWith('limits.dailyBudgetUsd: '))).toBe(true);
    expect(lines.some((l) => l.startsWith('engine.port: '))).toBe(true);
  });

  it('defaults the ui block to off (AC-1)', () => {
    const config = JarvisConfigSchema.parse(minimal);
    expect(config.ui.enabled).toBe(false);
    expect(config.ui.baseUrl).toBe('http://127.0.0.1:5173');
    expect(config.ui.leaseMinutes).toBe(15);
    expect(config.ui.maxScenarios).toBe(8);
    expect(config.ui.attachToPr).toBe(true);
    expect(config.ui.paths).toContain('**/*.tsx');
  });

  it('rejects a ui.baseUrl that is not on the loopback interface (AC-2)', () => {
    const result = JarvisConfigSchema.safeParse({
      ...minimal,
      ui: { baseUrl: 'http://0.0.0.0:5173' },
    });
    if (result.success) throw new Error('expected failure');
    expect(formatConfigError(result.error)).toMatch(/^ui\.baseUrl: .*127\.0\.0\.1/);
  });

  it('rejects a ui.readyPath that is not a path', () => {
    expect(JarvisConfigSchema.safeParse({ ...minimal, ui: { readyPath: 'tasks' } }).success).toBe(
      false,
    );
  });

  it('labels root-level problems', () => {
    const result = JarvisConfigSchema.safeParse(null);
    if (result.success) throw new Error('expected failure');
    expect(formatConfigError(result.error)).toMatch(/^\(root\): /);
  });
});
