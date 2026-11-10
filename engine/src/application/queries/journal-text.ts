import type { TaskEvent } from '../../domain/index.js';
import { shortSha } from '../code-host/worker-input.js';

/** The Overview event log filter (`stage`, `ci`, `review`, `permission`, `error`). */
export type EventGroup = 'stage' | 'ci' | 'review' | 'permission' | 'error';

export interface JournalText {
  readonly text: string;
  readonly group: EventGroup;
}

type Data = TaskEvent['data'];

const str = (data: Data, key: string, fallback = ''): string => {
  const value = data[key];
  return typeof value === 'string' && value !== '' ? value : fallback;
};

const num = (data: Data, key: string): string => {
  const value = data[key];
  return typeof value === 'number' ? String(value) : '?';
};

const withSuffix = (text: string, suffix: string): string =>
  suffix === '' ? text : `${text} — ${suffix}`;

const commandList = (data: Data): string => {
  const commands = Array.isArray(data['commands']) ? data['commands'].map(String) : [];
  return commands.length === 0 ? 'none' : commands.map((c) => `\`${c}\``).join(', ');
};

/** The commands of an engine-written `checks_failed` row that did not exit 0. */
function failedCommands(data: Data): string {
  const results = Array.isArray(data['results']) ? (data['results'] as unknown[]) : [];
  return results
    .filter((r): r is { command: string } => typeof r === 'object' && r !== null && 'command' in r)
    .filter((r) => (r as { exitCode?: unknown }).exitCode !== 0)
    .map((r) => r.command)
    .join(', ');
}

function stageChanged(data: Data): JournalText {
  const to = str(data, 'to');
  return {
    text: withSuffix(`Stage: ${str(data, 'from')} → ${to}`, str(data, 'reason')),
    group: to === 'Failed' ? 'error' : 'stage',
  };
}

function workerInput(data: Data): JournalText {
  const causes = Array.isArray(data['source']) ? data['source'].map(String) : [];
  const ci = causes.includes('ci_failed');
  return {
    text: `Automatic input for the worker: ${causes.join(', ') || 'unknown source'}`,
    group: ci || causes.length === 0 ? 'ci' : 'review',
  };
}

function ownerInput(event: TaskEvent): JournalText {
  const text =
    event.data['via'] === 'console'
      ? 'Owner message sent from the console'
      : event.actor === 'agent'
        ? 'The dispatcher forwarded a message to the worker'
        : 'Owner message';
  return { text, group: 'stage' };
}

/** Turns one journal row into the sentence the Task detail and Overview show (ST-03). */
export function describeJournalEvent(event: TaskEvent): JournalText {
  const { data } = event;
  switch (event.type) {
    case 'stage_changed':
      return stageChanged(data);
    case 'task_created':
      return { text: `Task created: ${str(data, 'title')}`, group: 'stage' };
    case 'worker_session_created':
      return { text: 'Worker session created', group: 'stage' };
    case 'worker_restarted':
      return { text: `Worker restarted from stage ${str(data, 'stage')}`, group: 'stage' };
    case 'stage_note':
      return {
        text: withSuffix(`Worker reported ${str(data, 'stage')}`, str(data, 'note')),
        group: 'stage',
      };
    case 'checks_passed':
      return {
        text: withSuffix(
          `Checks passed${data['headSha'] === undefined ? '' : ` on ${shortSha(str(data, 'headSha'))}`}`,
          str(data, 'summary'),
        ),
        group: 'ci',
      };
    case 'checks_failed':
      return {
        text: withSuffix(
          `Checks failed${data['headSha'] === undefined ? '' : ` on ${shortSha(str(data, 'headSha'))}`} (attempt ${num(data, 'attempt')}/${num(data, 'max')})`,
          str(data, 'summary') || failedCommands(data),
        ),
        group: 'ci',
      };
    case 'check_skipped':
      return {
        text: `Check skipped locally: ${str(data, 'command')} — ${str(data, 'reason')}`,
        group: 'ci',
      };
    case 'check_preexisting':
      return {
        text: `\`${str(data, 'command')}\` fails on main too (${shortSha(str(data, 'baseSha'))}); not counted against the task`,
        group: 'ci',
      };
    case 'check_base_result':
      return {
        text: `\`${str(data, 'command')}\` ${data['red'] === true ? 'is red' : 'is green'} on main (${shortSha(str(data, 'baseSha'))})`,
        group: 'ci',
      };
    case 'checks_declared':
      return {
        text: `Checks declared: ${commandList(data)}${data['source'] === 'worker' ? ' (found by the worker)' : ''}`,
        group: 'ci',
      };
    case 'checks_fixed':
      if (data['source'] === 'base_refresh') {
        return { text: `Checks updated from main: ${commandList(data)}`, group: 'ci' };
      }
      return {
        text: `Checks fixed by the owner's approval: ${commandList(data)}${
          data['source'] === 'agents_md_fallback'
            ? " (from AGENTS.md; the task predates the card's list)"
            : ''
        }`,
        group: 'ci',
      };
    case 'checks_started':
      return {
        text: `Checks started on ${shortSha(str(data, 'headSha'))} (attempt ${num(data, 'attempt')})`,
        group: 'ci',
      };
    case 'checks_unavailable':
      return {
        text: `Checks could not run: ${str(data, 'command')} — ${str(data, 'detail')}`,
        group: 'error',
      };
    case 'branch_pushed':
      return {
        text: `Branch ${str(data, 'branch')} pushed at ${shortSha(str(data, 'headSha'))}`,
        group: 'stage',
      };
    case 'push_failed':
      return {
        text: `Push of ${shortSha(str(data, 'headSha'))} failed (${str(data, 'reason')})`,
        group: 'error',
      };
    case 'pr_created':
      return {
        text: `Draft PR #${num(data, 'number')} created: ${str(data, 'url')}`,
        group: 'stage',
      };
    case 'pr_create_failed':
      return {
        text: withSuffix('GitHub refused the pull request', str(data, 'reason')),
        group: 'error',
      };
    case 'pr_opened':
      return {
        text: `Draft PR #${num(data, 'number')} ${data['created'] === false ? 'updated' : 'opened'}: ${str(data, 'url')}`,
        group: 'stage',
      };
    case 'pr_reported':
      return {
        text: `Draft PR #${num(data, 'number')} reported: ${str(data, 'url')}`,
        group: 'stage',
      };
    case 'ci_completed':
      return {
        text: `CI ${data['conclusion'] === 'success' ? 'passed' : 'failed'} on ${shortSha(str(data, 'headSha'))}`,
        group: 'ci',
      };
    case 'ci_rerun':
      return {
        text: `CI re-run on ${shortSha(str(data, 'headSha'))} (possibly flaky)`,
        group: 'ci',
      };
    case 'ci_fix_round':
      return {
        text: `CI fix round ${num(data, 'round')}/${num(data, 'max')} on ${shortSha(str(data, 'headSha'))}`,
        group: 'ci',
      };
    case 'review_approved':
      return { text: `Approved by ${str(data, 'reviewer', 'a reviewer')}`, group: 'review' };
    case 'review_round':
      return {
        text: `Review round ${num(data, 'round')}/${num(data, 'max')}`,
        group: 'review',
      };
    case 'comment_ignored':
      return {
        text: `Comment from ${str(data, 'author', 'someone')} ignored (${
          data['reason'] === 'bot' ? 'bot' : 'not on the allowlist'
        })`,
        group: 'review',
      };
    case 'agent_note':
      return { text: str(data, 'text', 'Agent note'), group: 'stage' };
    case 'permission_requested':
      return { text: `Permission requested for ${str(data, 'tool')}`, group: 'permission' };
    case 'permission_answered':
      return {
        text: `Permission for ${str(data, 'tool')}: ${str(data, 'decision')}`,
        group: 'permission',
      };
    case 'permission_timeout':
      return {
        text: `Permission for ${str(data, 'tool')} ${
          data['reason'] === 'run_ended' ? 'dropped: the run ended' : 'timed out (denied)'
        }`,
        group: 'permission',
      };
    case 'owner_input':
      return ownerInput(event);
    case 'worker_input':
      return workerInput(data);
    case 'retry_requested':
      return { text: `Retry requested for ${str(data, 'stage')}`, group: 'stage' };
    case 'run_stalled':
      return { text: 'The run produced no events for a while', group: 'error' };
    case 'run_interrupted':
      return { text: 'A run was interrupted by an engine restart', group: 'error' };
    case 'run_stopped':
      return { text: 'The owner stopped the run', group: 'stage' };
    default: {
      const words = event.type.replaceAll('_', ' ');
      return { text: words.charAt(0).toUpperCase() + words.slice(1), group: 'stage' };
    }
  }
}
