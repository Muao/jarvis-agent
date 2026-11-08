import type { ModelUsage, TokenUsage } from '@jarvis/shared';
import type { RunEventBody } from '../../application/index.js';
import type { RunOutcome } from '../../domain/index.js';

/** One thing found in a stream-json line. A `result` line yields all three kinds. */
export type ParsedLine =
  | { readonly type: 'event'; readonly body: RunEventBody }
  | { readonly type: 'session'; readonly sessionId: string }
  | { readonly type: 'outcome'; readonly outcome: RunOutcome };

export const TOOL_RESULT_LIMIT = 64 * 1024;
const TRUNCATED_MARKER = '\n[truncated]';
const RATE_LIMIT = /usage limit|limit reached|rate.?limit/i;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;
const num = (value: unknown): number => (typeof value === 'number' && value > 0 ? value : 0);

/** Splits a byte stream into complete lines; the tail waits for its newline (or `flush`). */
export function createStreamParser(): {
  push(chunk: string): string[];
  flush(): string[];
} {
  let tail = '';
  return {
    push(chunk) {
      const parts = (tail + chunk).split('\n');
      tail = parts.pop() ?? '';
      return parts.map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== '');
    },
    flush() {
      const rest = tail.trim();
      tail = '';
      return rest === '' ? [] : [rest];
    },
  };
}

function truncate(text: string): string {
  return text.length <= TOOL_RESULT_LIMIT
    ? text
    : `${text.slice(0, TOOL_RESULT_LIMIT)}${TRUNCATED_MARKER}`;
}

/** Tool result content is a string or an array of blocks; only text survives. */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (!isObject(block)) return '';
      return typeof block['text'] === 'string'
        ? block['text']
        : `[${str(block['type']) ?? 'block'}]`;
    })
    .filter((part) => part !== '')
    .join('\n');
}

function usageOf(value: unknown): TokenUsage {
  const usage = isObject(value) ? value : {};
  return {
    input: num(usage['input_tokens']),
    output: num(usage['output_tokens']),
    cacheRead: num(usage['cache_read_input_tokens']),
    cacheWrite: num(usage['cache_creation_input_tokens']),
  };
}

/**
 * `modelUsage` maps a model id to camelCase counters. The field names are NOT verified against a real
 * run (ADR-0011: tests never start `claude`); they follow the Agent SDK's `ModelUsage` type:
 * `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD`.
 * Anything else parses to zeros, and a missing or malformed key yields `{}`.
 */
export function modelUsageOf(value: unknown): ModelUsage {
  if (!isObject(value)) return {};
  const out: Record<string, ModelUsage[string]> = {};
  for (const [model, raw] of Object.entries(value)) {
    const entry = isObject(raw) ? raw : {};
    out[model] = {
      input: Math.round(num(entry['inputTokens'])),
      output: Math.round(num(entry['outputTokens'])),
      cacheRead: Math.round(num(entry['cacheReadInputTokens'])),
      cacheWrite: Math.round(num(entry['cacheCreationInputTokens'])),
      costUsd: num(entry['costUSD']),
    };
  }
  return out;
}

const event = (body: RunEventBody): ParsedLine => ({ type: 'event', body });

function parseMessage(line: Json, parent: { parentToolUseId?: string }): ParsedLine[] {
  const message = isObject(line['message']) ? line['message'] : {};
  const content = Array.isArray(message['content']) ? message['content'] : [];
  const out: ParsedLine[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (line['type'] === 'assistant') {
      if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'] !== '') {
        out.push(event({ kind: 'text', ...parent, payload: { text: block['text'] } }));
      } else if (block['type'] === 'tool_use') {
        const toolUseId = str(block['id']);
        const name = str(block['name']);
        if (toolUseId && name) {
          const input = isObject(block['input']) ? block['input'] : {};
          out.push(event({ kind: 'tool_use', ...parent, payload: { toolUseId, name, input } }));
        }
      }
    } else if (block['type'] === 'tool_result') {
      const toolUseId = str(block['tool_use_id']);
      if (toolUseId) {
        out.push(
          event({
            kind: 'tool_result',
            ...parent,
            payload: {
              toolUseId,
              content: truncate(flattenContent(block['content'])),
              isError: block['is_error'] === true,
            },
          }),
        );
      }
    }
  }
  return out;
}

function parseResult(line: Json, parent: { parentToolUseId?: string }): ParsedLine[] {
  const subtype = str(line['subtype']) ?? 'unknown';
  const isError = line['is_error'] === true;
  const text =
    typeof line['result'] === 'string' && line['result'] !== '' ? line['result'] : undefined;
  const totals = {
    costUsd: num(line['total_cost_usd']),
    turns: Math.round(num(line['num_turns'])),
    usage: usageOf(line['usage']),
  };
  const modelUsage = modelUsageOf(line['modelUsage']);
  const out: ParsedLine[] = [
    event({
      kind: 'result',
      ...parent,
      payload: {
        subtype,
        isError,
        turns: totals.turns,
        durationMs: Math.round(num(line['duration_ms'])),
        costUsd: totals.costUsd,
        usage: totals.usage,
        ...(text !== undefined ? { text } : {}),
      },
    }),
  ];
  const sessionId = str(line['session_id']);
  if (sessionId) out.push({ type: 'session', sessionId });
  const message = text !== undefined ? { message: text } : {};
  out.push({
    type: 'outcome',
    outcome:
      isError && text !== undefined && RATE_LIMIT.test(text)
        ? { type: 'rate_limited', message: text }
        : { type: 'result', subtype, ...message, ...totals, modelUsage },
  });
  return out;
}

/** Normalises one stream-json line. Never throws: unknown or broken lines become `system` events. */
export function parseLine(raw: string): ParsedLine[] {
  let line: unknown;
  try {
    line = JSON.parse(raw);
  } catch {
    return [
      event({ kind: 'system', payload: { subtype: 'unparsed_line', message: raw.slice(0, 500) } }),
    ];
  }
  if (!isObject(line)) {
    return [
      event({ kind: 'system', payload: { subtype: 'unparsed_line', message: raw.slice(0, 500) } }),
    ];
  }
  const type = str(line['type']) ?? 'unknown';
  const parentToolUseId = str(line['parent_tool_use_id']);
  const parent = parentToolUseId !== undefined ? { parentToolUseId } : {};

  switch (type) {
    case 'assistant':
    case 'user':
      return parseMessage(line, parent);
    case 'result':
      return parseResult(line, parent);
    case 'system': {
      const subtype = str(line['subtype']) ?? 'system';
      const model = str(line['model']);
      const out: ParsedLine[] = [
        event({
          kind: 'system',
          ...parent,
          payload: { subtype, ...(model !== undefined ? { message: `model ${model}` } : {}) },
        }),
      ];
      const sessionId = str(line['session_id']);
      if (subtype === 'init' && sessionId) out.push({ type: 'session', sessionId });
      return out;
    }
    default:
      return [event({ kind: 'system', ...parent, payload: { subtype: type } })];
  }
}
