import type { WatchedCheck } from '../ports/watch-repository.js';

export const shortSha = (sha: string): string => sha.slice(0, 7);

export function names(checks: readonly WatchedCheck[]): string {
  return checks.map((c) => c.name).join(', ');
}

/** CI-04: what the worker needs to find the cause: the failing check names and where their logs are. */
export function ciFailureInput(input: {
  readonly prNumber: number;
  readonly prUrl: string;
  readonly headSha: string;
  readonly failed: readonly WatchedCheck[];
  readonly round: number;
  readonly maxRounds: number;
}): string {
  const lines = input.failed.map((c) => `- ${c.name}: ${c.url ?? `${input.prUrl}/checks`}`);
  return [
    `CI failed on PR #${input.prNumber} at commit ${shortSha(input.headSha)} (fix round ${input.round}/${input.maxRounds}). Failing checks:`,
    ...lines,
    'Read the logs, find the cause, fix it with a new commit and push.',
  ].join('\n');
}

/** CI-05: the allowlisted reviewers' feedback, verbatim. */
export function reviewInput(input: {
  readonly prNumber: number;
  readonly entries: readonly string[];
  readonly round: number;
  readonly maxRounds: number;
}): string {
  return [
    `Review feedback on PR #${input.prNumber} (review round ${input.round}/${input.maxRounds}):`,
    ...input.entries,
    'Make the changes, push a new commit and say in the thread what you changed.',
  ].join('\n');
}
