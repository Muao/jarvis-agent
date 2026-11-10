import type { RunEvent } from '@jarvis/shared';
import type { RunRepository } from '../ports/run-repository.js';

const ARGUMENT_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description'];
const MAX_ARGUMENT = 80;
const MAX_NOTE = 140;
/** A command can carry a token or a path with a secret in it; only its head is shown in the chat. */
const MAX_COMMAND_HEAD = 30;

function argumentOf(
  input: Record<string, unknown>,
  maxCommand: number = MAX_ARGUMENT,
): string | null {
  for (const key of ARGUMENT_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value !== '') {
      const line = value.split('\n')[0] ?? value;
      const max = key === 'command' ? maxCommand : MAX_ARGUMENT;
      return line.length > max ? `${line.slice(0, max - 1)}…` : line;
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

/** The first non-empty line of an assistant text event, cut to a chat-sized note. Never a tool result. */
export function describeNote(event: RunEvent | null): string | null {
  if (event?.kind !== 'text') return null;
  const line = event.payload.text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (line === undefined) return null;
  return line.length > MAX_NOTE ? `${line.slice(0, MAX_NOTE - 1)}…` : line;
}

/** A tool call as a name plus a short target (a file path, a command head); never its result. */
export function describeToolUse(event: RunEvent | null): string | null {
  if (event?.kind !== 'tool_use') return null;
  const argument = argumentOf(event.payload.input, MAX_COMMAND_HEAD);
  return argument === null ? event.payload.name : `${event.payload.name} ${argument}`;
}

/** What a run last said and last did, skipping thinking and other system noise. */
export interface RunProgress {
  readonly note: string | null;
  readonly tool: string | null;
}

export async function latestProgress(runs: RunRepository, runId: string): Promise<RunProgress> {
  const [note] = await runs.lastEventsOfKinds(runId, ['text'], 1);
  const [tool] = await runs.lastEventsOfKinds(runId, ['tool_use'], 1);
  return { note: describeNote(note ?? null), tool: describeToolUse(tool ?? null) };
}

/** "Last note: … · Now: …", or null when the run has done neither yet. */
export function describeProgress({ note, tool }: RunProgress): string | null {
  const parts = [
    note === null ? null : `Last note: ${note}`,
    tool === null ? null : `Now: ${tool}`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}
