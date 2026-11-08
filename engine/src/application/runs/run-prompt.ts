export interface WorkerPromptInput {
  readonly taskId: string;
  readonly branch: string;
  readonly artifactsDir: string;
  readonly stage: string;
  /**
   * ADR-0022: `available`, or `disabled: <reason>`. The engine decides, so the worker never has
   * to guess why the browser does not answer, and never tries to arrange one itself.
   */
  readonly uiCheck: string;
  /** USER.md, read fresh for this run. */
  readonly preferences: string | null;
  /** Owner messages that arrived while no run was live, oldest first. */
  readonly pending: readonly string[];
  /** The task description; only a session's first run needs it, a resumed session has it already. */
  readonly description: string | null;
}

const PREFERENCES_HEADING = '## Owner preferences (USER.md)';

function preferencesSection(preferences: string | null): string[] {
  const text = preferences?.trim() ?? '';
  return text === '' ? [] : [PREFERENCES_HEADING, text];
}

function bullet(text: string): string {
  return `- ${text.trim().replaceAll('\n', '\n  ')}`;
}

/**
 * The first user message of a worker run, in the "Run context" format that `agent/prompts/worker.md`
 * documents. USER.md goes here, not into the system prompt, because the CLI keeps a session's
 * system prompt from its first request (PRF-03).
 */
export function workerFirstMessage(input: WorkerPromptInput): string {
  const lines = [
    '## Run context',
    `taskId: ${input.taskId}`,
    `branch: ${input.branch}`,
    `artifactsDir: ${input.artifactsDir}`,
    `stage: ${input.stage}`,
    `uiCheck: ${input.uiCheck}`,
    ...preferencesSection(input.preferences),
  ];
  if (input.pending.length > 0)
    lines.push('## Pending owner messages', ...input.pending.map(bullet));
  if (input.description !== null) lines.push('## Task description', input.description.trim());
  return lines.join('\n');
}

/** The first user message of a dispatcher turn (`agent/prompts/dispatcher.md`). */
export function dispatcherFirstMessage(input: {
  readonly preferences: string | null;
  readonly messages: readonly string[];
}): string {
  return [
    ...preferencesSection(input.preferences),
    '## Owner messages',
    input.messages.map((m) => m.trim()).join('\n\n'),
  ].join('\n');
}
