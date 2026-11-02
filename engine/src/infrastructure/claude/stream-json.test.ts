import { describe, expect, it } from 'vitest';
import {
  createStreamParser,
  parseLine,
  TOOL_RESULT_LIMIT,
  type ParsedLine,
} from './stream-json.js';

const parse = (value: unknown): ParsedLine[] => parseLine(JSON.stringify(value));
const events = (lines: ParsedLine[]) => lines.flatMap((l) => (l.type === 'event' ? [l.body] : []));

describe('createStreamParser', () => {
  it('joins lines split across chunks and keeps the tail until flush', () => {
    const parser = createStreamParser();
    expect(parser.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(parser.push(':2}\r\n\n{"c":3}')).toEqual(['{"b":2}']);
    expect(parser.flush()).toEqual(['{"c":3}']);
    expect(parser.flush()).toEqual([]);
  });
});

describe('parseLine', () => {
  it('init: a system event and the session id', () => {
    const lines = parse({
      type: 'system',
      subtype: 'init',
      session_id: 's-1',
      model: 'claude-sonnet',
    });
    expect(lines).toEqual([
      {
        type: 'event',
        body: { kind: 'system', payload: { subtype: 'init', message: 'model claude-sonnet' } },
      },
      { type: 'session', sessionId: 's-1' },
    ]);
  });

  it('assistant text and tool_use; thinking is skipped', () => {
    const lines = parse({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    expect(events(lines)).toEqual([
      { kind: 'text', payload: { text: 'Hello' } },
      { kind: 'tool_use', payload: { toolUseId: 'tu_1', name: 'Bash', input: { command: 'ls' } } },
    ]);
  });

  it('subagent events keep the parent tool use id', () => {
    const lines = parse({
      type: 'assistant',
      parent_tool_use_id: 'tu_parent',
      message: { content: [{ type: 'text', text: 'inside' }] },
    });
    expect(events(lines)).toEqual([
      { kind: 'text', parentToolUseId: 'tu_parent', payload: { text: 'inside' } },
    ]);
  });

  it('tool_result: string content and array content flattened to text', () => {
    const fromString = parse({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
    });
    expect(events(fromString)).toEqual([
      { kind: 'tool_result', payload: { toolUseId: 'tu_1', content: 'ok', isError: false } },
    ]);

    const fromArray = parse({
      type: 'user',
      parent_tool_use_id: 'tu_p',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_2',
            is_error: true,
            content: [
              { type: 'text', text: 'line one' },
              { type: 'image', source: {} },
              { type: 'text', text: 'line two' },
            ],
          },
        ],
      },
    });
    expect(events(fromArray)).toEqual([
      {
        kind: 'tool_result',
        parentToolUseId: 'tu_p',
        payload: { toolUseId: 'tu_2', content: 'line one\n[image]\nline two', isError: true },
      },
    ]);
  });

  it('truncates huge tool results with a marker', () => {
    const lines = parse({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu_3', content: 'x'.repeat(TOOL_RESULT_LIMIT + 10) },
        ],
      },
    });
    const [body] = events(lines);
    if (body?.kind !== 'tool_result') throw new Error('expected tool_result');
    expect(body.payload.content.length).toBe(TOOL_RESULT_LIMIT + '\n[truncated]'.length);
    expect(body.payload.content.endsWith('[truncated]')).toBe(true);
  });

  it('result success: event, session and outcome with totals', () => {
    const lines = parse({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 3,
      duration_ms: 1234.4,
      total_cost_usd: 0.0421,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      },
      result: 'Done',
      session_id: 's-2',
    });
    const usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 };
    expect(lines).toEqual([
      {
        type: 'event',
        body: {
          kind: 'result',
          payload: {
            subtype: 'success',
            isError: false,
            turns: 3,
            durationMs: 1234,
            costUsd: 0.0421,
            usage,
            text: 'Done',
          },
        },
      },
      { type: 'session', sessionId: 's-2' },
      {
        type: 'outcome',
        outcome: {
          type: 'result',
          subtype: 'success',
          message: 'Done',
          costUsd: 0.0421,
          turns: 3,
          usage,
        },
      },
    ]);
  });

  it.each(['error_max_turns', 'error_max_budget_usd', 'error_during_execution'])(
    'result %s keeps its subtype in the outcome',
    (subtype) => {
      const lines = parse({
        type: 'result',
        subtype,
        is_error: true,
        num_turns: 1,
        total_cost_usd: 1,
      });
      const outcome = lines.find((l) => l.type === 'outcome');
      expect(outcome).toMatchObject({ outcome: { type: 'result', subtype, costUsd: 1, turns: 1 } });
    },
  );

  it('maps an exhausted subscription to rate_limited', () => {
    const lines = parse({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Claude AI usage limit reached|1700000000',
    });
    expect(lines.find((l) => l.type === 'outcome')).toEqual({
      type: 'outcome',
      outcome: { type: 'rate_limited', message: 'Claude AI usage limit reached|1700000000' },
    });
  });

  it('unknown or broken lines become system events and never throw', () => {
    expect(events(parse({ type: 'rate_limit_event' }))).toEqual([
      { kind: 'system', payload: { subtype: 'rate_limit_event' } },
    ]);
    expect(events(parseLine('not json'))).toEqual([
      { kind: 'system', payload: { subtype: 'unparsed_line', message: 'not json' } },
    ]);
    expect(events(parseLine('[1,2]'))).toHaveLength(1);
    expect(events(parse({ type: 'assistant', message: 'weird' }))).toEqual([]);
  });
});
