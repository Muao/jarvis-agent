import { describe, expect, it } from 'vitest';
import { taskEvent, type EventActor } from '../../domain/index.js';
import { describeJournalEvent } from './journal-text.js';

const at = '2026-01-01T10:00:00.000Z';
const describeOf = (
  type: string,
  data: Record<string, unknown> = {},
  actor: EventActor = 'system',
) => describeJournalEvent(taskEvent('T-1', type, at, actor, data));

describe('describeJournalEvent', () => {
  it.each([
    ['stage_changed', { from: 'Intake', to: 'Context' }, 'Stage: Intake → Context', 'stage'],
    [
      'stage_changed',
      { from: 'Context', to: 'Blocked', reason: 'Which db?' },
      'Stage: Context → Blocked — Which db?',
      'stage',
    ],
    [
      'stage_changed',
      { from: 'Verifying', to: 'Failed', reason: 'Checks still failing' },
      'Stage: Verifying → Failed — Checks still failing',
      'error',
    ],
    ['task_created', { title: 'Add /health' }, 'Task created: Add /health', 'stage'],
    ['worker_session_created', {}, 'Worker session created', 'stage'],
    [
      'worker_restarted',
      { stage: 'Implementing' },
      'Worker restarted from stage Implementing',
      'stage',
    ],
    ['stage_note', { stage: 'Verifying', note: null }, 'Worker reported Verifying', 'stage'],
    [
      'stage_note',
      { stage: 'Verifying', note: 'tests next' },
      'Worker reported Verifying — tests next',
      'stage',
    ],
    ['checks_passed', { summary: 'all green' }, 'Checks passed — all green', 'ci'],
    [
      'checks_failed',
      { summary: 'lint broke', attempt: 2, max: 3 },
      'Checks failed (attempt 2/3) — lint broke',
      'ci',
    ],
    [
      'pr_reported',
      { number: 7, url: 'https://x/7' },
      'Draft PR #7 reported: https://x/7',
      'stage',
    ],
    ['ci_completed', { headSha: 'abcdef123', conclusion: 'success' }, 'CI passed on abcdef1', 'ci'],
    ['ci_completed', { headSha: 'abcdef123', conclusion: 'failure' }, 'CI failed on abcdef1', 'ci'],
    ['ci_rerun', { headSha: 'abcdef123' }, 'CI re-run on abcdef1 (possibly flaky)', 'ci'],
    [
      'ci_fix_round',
      { round: 1, max: 2, headSha: 'abcdef123' },
      'CI fix round 1/2 on abcdef1',
      'ci',
    ],
    ['review_approved', { reviewer: 'alice' }, 'Approved by alice', 'review'],
    ['review_round', { round: 2, max: 3 }, 'Review round 2/3', 'review'],
    [
      'comment_ignored',
      { author: 'bob', reason: 'not_allowlisted' },
      'Comment from bob ignored (not on the allowlist)',
      'review',
    ],
    [
      'comment_ignored',
      { author: 'ci-bot', reason: 'bot' },
      'Comment from ci-bot ignored (bot)',
      'review',
    ],
    ['permission_requested', { tool: 'Bash' }, 'Permission requested for Bash', 'permission'],
    [
      'permission_answered',
      { tool: 'Bash', decision: 'deny' },
      'Permission for Bash: deny',
      'permission',
    ],
    [
      'permission_timeout',
      { tool: 'Bash' },
      'Permission for Bash timed out (denied)',
      'permission',
    ],
    [
      'permission_timeout',
      { tool: 'Bash', reason: 'run_ended' },
      'Permission for Bash dropped: the run ended',
      'permission',
    ],
    ['worker_input', { source: ['ci_failed'] }, 'Automatic input for the worker: ci_failed', 'ci'],
    [
      'worker_input',
      { source: ['review_comment'] },
      'Automatic input for the worker: review_comment',
      'review',
    ],
    ['retry_requested', { stage: 'Failed' }, 'Retry requested for Failed', 'stage'],
    ['run_stalled', { runId: 'r-1' }, 'The run produced no events for a while', 'error'],
    ['run_interrupted', { runId: 'r-1' }, 'A run was interrupted by an engine restart', 'error'],
    ['run_stopped', { runId: 'r-1' }, 'The owner stopped the run', 'stage'],
    ['agent_note', { text: 'Chose option B' }, 'Chose option B', 'stage'],
    ['agent_note', {}, 'Agent note', 'stage'],
    ['something_new', {}, 'Something new', 'stage'],
    // ADR-0022: rows the engine writes while it runs the checks and opens the PR.
    [
      'checks_declared',
      { commands: ['pnpm test'], source: 'worker' },
      'Checks declared: `pnpm test` (found by the worker)',
      'ci',
    ],
    [
      'checks_fixed',
      { commands: ['pnpm test', 'pnpm lint'], source: 'agents_md' },
      "Checks fixed by the owner's approval: `pnpm test`, `pnpm lint`",
      'ci',
    ],
    [
      'checks_started',
      { attempt: 2, headSha: 'a1b2c3d4e5f6', commands: [] },
      'Checks started on a1b2c3d (attempt 2)',
      'ci',
    ],
    [
      'checks_failed',
      {
        headSha: 'a1b2c3d4e5f6',
        attempt: 1,
        max: 3,
        results: [
          { command: 'pnpm test', exitCode: 1 },
          { command: 'pnpm lint', exitCode: 0 },
        ],
      },
      'Checks failed on a1b2c3d (attempt 1/3) — pnpm test',
      'ci',
    ],
    ['checks_passed', { headSha: 'a1b2c3d4e5f6', results: [] }, 'Checks passed on a1b2c3d', 'ci'],
    [
      'checks_unavailable',
      { command: 'pnpm test', detail: 'not found' },
      'Checks could not run: pnpm test — not found',
      'error',
    ],
    [
      'branch_pushed',
      { branch: 'jarvis/T-1', headSha: 'a1b2c3d4e5f6' },
      'Branch jarvis/T-1 pushed at a1b2c3d',
      'stage',
    ],
    [
      'pr_opened',
      { number: 7, url: 'https://x/7', created: false },
      'Draft PR #7 updated: https://x/7',
      'stage',
    ],
  ])('%s %j -> "%s" (%s)', (type, data, text, group) => {
    expect(describeOf(type, data)).toEqual({ text, group });
  });

  it('tells apart who sent an owner_input', () => {
    expect(describeOf('owner_input', {}, 'owner').text).toBe('Owner message');
    expect(describeOf('owner_input', { via: 'console' }, 'owner').text).toBe(
      'Owner message sent from the console',
    );
    expect(describeOf('owner_input', {}, 'agent').text).toBe(
      'The dispatcher forwarded a message to the worker',
    );
  });
});
