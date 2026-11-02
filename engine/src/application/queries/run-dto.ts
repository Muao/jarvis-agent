import type { RunDto, TaskStage } from '@jarvis/shared';
import type { Run } from '../../domain/index.js';

/**
 * `maxTurns` is the limit in force now: a run does not store the limits it started with, so after a
 * config change an old run shows the new value.
 */
export function toRunDto(run: Run, context: { stage: TaskStage | null; maxTurns: number }): RunDto {
  return {
    id: run.id,
    sessionId: run.sessionId,
    taskId: run.taskId,
    role: run.role,
    stage: context.stage,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.finishedAt,
    usage: run.usage,
    costUsd: run.costUsd,
    turns: run.turns,
    maxTurns: context.maxTurns,
    exitCode: run.exitCode,
    error: run.error,
  };
}
