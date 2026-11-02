import { describe, expect, it } from 'vitest';
import { RunEventKindSchema } from './enums.js';
import { RunEventSchema, type RunEvent } from './run-event.js';
import { StreamEventSchema } from './stream.js';

const base = { seq: 0, runId: 'r1', at: '2026-10-26T10:00:00.000Z' };

const samples: Record<RunEvent['kind'], RunEvent> = {
  text: { ...base, kind: 'text', payload: { text: 'hello' } },
  tool_use: {
    ...base,
    kind: 'tool_use',
    parentToolUseId: 'tu0',
    payload: { toolUseId: 'tu1', name: 'Read', input: {} },
  },
  tool_result: {
    ...base,
    kind: 'tool_result',
    payload: { toolUseId: 'tu1', content: 'ok', isError: false },
  },
  permission: {
    ...base,
    kind: 'permission',
    payload: { permissionId: 'p1', toolName: 'Bash', decision: 'pending' },
  },
  system: { ...base, kind: 'system', payload: { subtype: 'init' } },
  result: {
    ...base,
    kind: 'result',
    payload: {
      subtype: 'success',
      isError: false,
      turns: 2,
      durationMs: 1200,
      costUsd: 0.01,
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    },
  },
  error: { ...base, kind: 'error', payload: { message: 'boom' } },
};

describe('RunEventSchema', () => {
  it('has a sample for every kind', () => {
    expect(Object.keys(samples).sort()).toEqual([...RunEventKindSchema.options].sort());
  });

  it.each(Object.values(samples))('parses a $kind event', (event) => {
    expect(RunEventSchema.parse(event)).toEqual(event);
  });

  it('rejects a payload that does not match its kind', () => {
    expect(
      RunEventSchema.safeParse({ ...base, kind: 'text', payload: { message: 'x' } }).success,
    ).toBe(false);
    expect(RunEventSchema.safeParse({ ...base, kind: 'unknown', payload: {} }).success).toBe(false);
  });
});

describe('StreamEventSchema', () => {
  it.each([
    { type: 'thread', id: 'th1' },
    { type: 'task', id: 'T-1' },
    { type: 'run', id: 'r1' },
    { type: 'run_event', id: 'r1', data: samples.text },
    { type: 'overview' },
    { type: 'config' },
  ])('parses $type', (event) => {
    expect(StreamEventSchema.parse(event)).toEqual(event);
  });

  it('rejects unknown types and a run_event without data', () => {
    expect(StreamEventSchema.safeParse({ type: 'bogus', id: 'x' }).success).toBe(false);
    expect(StreamEventSchema.safeParse({ type: 'run_event', id: 'r1' }).success).toBe(false);
  });
});
