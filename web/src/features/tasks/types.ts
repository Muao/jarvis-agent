import type { TaskDetailDto } from '@jarvis/shared';

/** Pieces of `TaskDetailDto` that components take on their own. */
export type StageSpan = TaskDetailDto['stages'][number];
export type JournalEntry = TaskDetailDto['journal'][number];
export type PullRequest = NonNullable<TaskDetailDto['pullRequest']>;
export type Check = PullRequest['checks'][number];
export type ReviewComment = PullRequest['comments'][number];
