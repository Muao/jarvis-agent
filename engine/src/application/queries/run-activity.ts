import type { RunEvent } from '@jarvis/shared';

const ARGUMENT_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description'];
const MAX_ARGUMENT = 80;

function argumentOf(input: Record<string, unknown>): string | null {
  for (const key of ARGUMENT_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value !== '') {
      const line = value.split('\n')[0] ?? value;
      return line.length > MAX_ARGUMENT ? `${line.slice(0, MAX_ARGUMENT - 1)}…` : line;
    }
  }
  return null;
}

/** What a live run is doing, from its newest event: a tool and its argument, or "Thinking" (Overview cards). */
export function describeActivity(last: RunEvent | null): string {
  if (last?.kind === 'tool_use') {
    const argument = argumentOf(last.payload.input);
    return argument === null ? last.payload.name : `${last.payload.name}: ${argument}`;
  }
  if (last?.kind === 'permission' && last.payload.decision === 'pending') {
    return `Waiting for permission: ${last.payload.toolName}`;
  }
  return 'Thinking';
}
