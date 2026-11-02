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
    });
    expect(config.watch.pollSeconds).toBe(60);
    expect(config.models).toEqual({ dispatcher: 'sonnet', worker: 'sonnet', reviewer: 'sonnet' });
    expect(config.allowlist).toEqual({ githubReviewers: [], autoAllowedCommands: [] });
    expect(config.engine).toEqual({ port: 4310, claudeBinary: 'claude' });
  });

  it('keeps explicit values and partial sections', () => {
    const config = JarvisConfigSchema.parse({ ...minimal, limits: { dailyBudgetUsd: 5 } });
    expect(config.limits.dailyBudgetUsd).toBe(5);
    expect(config.limits.checkRetries).toBe(3);
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

  it('labels root-level problems', () => {
    const result = JarvisConfigSchema.safeParse(null);
    if (result.success) throw new Error('expected failure');
    expect(formatConfigError(result.error)).toMatch(/^\(root\): /);
  });
});
