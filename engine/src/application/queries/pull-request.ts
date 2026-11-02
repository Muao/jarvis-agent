import type { CheckStatus, TaskDetailDto } from '@jarvis/shared';
import type { Task } from '../../domain/index.js';
import type { Watch, WatchedCheck, WatchSummary } from '../ports/watch-repository.js';

type PullRequestDto = NonNullable<TaskDetailDto['pullRequest']>;

/** One word for the checks of the head commit; null until the watcher saw checks. */
export function ciStatusOf(summary: WatchSummary | null): CheckStatus | null {
  if (summary === null || summary.checks.length === 0) return null;
  if (summary.ciGreen) return 'passed';
  const statuses = summary.checks.map((c) => c.status);
  for (const status of ['failed', 'running', 'queued'] as const) {
    if (statuses.includes(status)) return status;
  }
  return statuses.every((s) => s === 'skipped') ? 'skipped' : 'passed';
}

const toCheckDto = (check: WatchedCheck): PullRequestDto['checks'][number] => ({
  name: check.name,
  status: check.status,
  // The watcher stores no start or end times, so there is no duration to show.
  durationMs: null,
  url: check.url,
});

/**
 * The PR block of Task detail. Before the first poll the PR is known (the worker reported it) but not
 * its checks, so the block shows the link with nothing under it.
 */
export function pullRequestOf(task: Task, watch: Watch | null): PullRequestDto | null {
  if (task.pr === null) return null;
  const summary = watch?.summary ?? null;
  return {
    number: task.pr.number,
    url: task.pr.url,
    headSha: summary?.headSha ?? '',
    checks: (summary?.checks ?? []).map(toCheckDto),
    earlierChecks: (summary?.earlierChecks ?? []).map(toCheckDto),
    review: summary?.review ?? 'pending',
    comments: (summary?.comments ?? []).map((c) => ({
      id: c.id,
      author: c.author,
      body: c.body,
      handling: c.handling,
    })),
    lastCheckedAt: watch?.lastCheckedAt ?? null,
  };
}
