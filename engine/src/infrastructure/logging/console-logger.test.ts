import { describe, expect, it } from 'vitest';
import { createRedactor } from '../config/redact.js';
import { ConsoleLogger } from './console-logger.js';

describe('ConsoleLogger', () => {
  const lines: string[] = [];
  const logger = new ConsoleLogger({
    redact: createRedactor(['s3cret-value']),
    write: (line) => lines.push(line),
    now: () => new Date('2026-01-02T03:04:05.000Z'),
  });

  it('writes one JSON line with level, message and context', () => {
    lines.length = 0;
    logger.warn('slow', { taskId: 'T-1' });
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      time: '2026-01-02T03:04:05.000Z',
      level: 'warn',
      message: 'slow',
      taskId: 'T-1',
    });
  });

  it('redacts secrets anywhere in the line', () => {
    lines.length = 0;
    logger.error('failed with s3cret-value', { error: 'token s3cret-value rejected' });
    expect(lines[0]).not.toContain('s3cret-value');
    expect(lines[0]).toContain('[redacted]');
  });

  it('survives a context that cannot be serialised', () => {
    lines.length = 0;
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    logger.error('cycle', { cyclic });
    expect(JSON.parse(lines[0] ?? '').message).toBe('cycle');
  });

  it('writes info lines with the event key at level info', () => {
    lines.length = 0;
    logger.info('run started', { event: 'run.started', runId: 'R-1' });
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      time: '2026-01-02T03:04:05.000Z',
      level: 'info',
      message: 'run started',
      event: 'run.started',
      runId: 'R-1',
    });
  });

  it('redacts secrets in info lines too', () => {
    lines.length = 0;
    logger.info('token s3cret-value', { event: 'task.stage', note: 's3cret-value' });
    expect(lines[0]).not.toContain('s3cret-value');
    expect(lines[0]).toContain('[redacted]');
  });

  it('drops info at level warn and keeps warn and error', () => {
    const quiet: string[] = [];
    const warnOnly = new ConsoleLogger({
      redact: (text) => text,
      write: (line) => quiet.push(line),
      level: 'warn',
    });
    warnOnly.info('hidden', { event: 'run.started' });
    warnOnly.warn('shown');
    warnOnly.error('shown too');
    expect(quiet.map((l) => JSON.parse(l).level)).toEqual(['warn', 'error']);
  });

  it('drops warn and info at level error', () => {
    const quiet: string[] = [];
    const errorOnly = new ConsoleLogger({
      redact: (text) => text,
      write: (line) => quiet.push(line),
      level: 'error',
    });
    errorOnly.info('a');
    errorOnly.warn('b');
    errorOnly.error('c');
    expect(quiet.map((l) => JSON.parse(l).level)).toEqual(['error']);
  });
});
