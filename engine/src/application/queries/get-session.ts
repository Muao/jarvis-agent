import type { SessionDto, SessionStatus } from '@jarvis/shared';
import { isStalled, type Run } from '../../domain/index.js';
import { NotFoundError } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { toRunDto } from './run-dto.js';
import { stageAt, stageSpans } from './stage-spans.js';

function statusOf(runs: readonly Run[], runsAwaitingOwner: ReadonlySet<string>): SessionStatus {
  const live = runs.find((run) => run.status === 'running');
  if (live !== undefined) {
    return runsAwaitingOwner.has(live.id) ? 'waiting_for_permission' : 'running';
  }
  const last = runs.at(-1)?.status;
  if (last === 'failed') return 'error';
  return last === 'stopped' ? 'stopped' : 'idle';
}

/** `GET /api/sessions/:id`: the session header and its runs, oldest first (ADM-03). */
export class GetSession {
  constructor(
    private readonly deps: {
      readonly uow: UnitOfWork;
      readonly config: ConfigProvider;
      readonly clock: Clock;
    },
  ) {}

  execute(id: string): Promise<SessionDto> {
    const { limits, models } = this.deps.config.current();
    const now = this.deps.clock.now();
    return this.deps.uow.run(async (tx) => {
      const session = await tx.sessions.get(id);
      if (session === null) throw new NotFoundError('session', id);
      const runs = await tx.runs.listBySession(id);
      const task = session.taskId === null ? null : await tx.tasks.get(session.taskId);
      const spans = task === null ? null : stageSpans(task, await tx.journal.list(task.id));
      const awaiting = new Set((await tx.permissions.listPending()).map((p) => p.runId));
      const live = runs.find((run) => run.status === 'running');
      const lastActivity =
        live === undefined ? null : ((await tx.runs.lastEvent(live.id))?.at ?? live.startedAt);
      return {
        id: session.id,
        role: session.role,
        taskId: session.taskId,
        threadId: session.threadId,
        model: models[session.role],
        status: statusOf(runs, awaiting),
        claudeSessionId: session.claudeSessionId,
        stalled: lastActivity !== null && isStalled(lastActivity, now, limits),
        runs: runs.map((run) =>
          toRunDto(run, {
            stage: spans === null ? null : stageAt(spans, run.startedAt),
            maxTurns: limits.maxTurnsPerRun,
          }),
        ),
      };
    });
  }
}
