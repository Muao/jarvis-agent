import type { RunEventsDto } from '@jarvis/shared';
import { NotFoundError } from '../errors.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** `GET /api/runs/:id/events?afterSeq=`: the run's events after `afterSeq`, oldest first (ADM-04). */
export class GetRunEvents {
  constructor(private readonly deps: { readonly uow: UnitOfWork }) {}

  execute(runId: string, afterSeq?: number): Promise<RunEventsDto> {
    return this.deps.uow.run(async (tx) => {
      if ((await tx.runs.get(runId)) === null) throw new NotFoundError('run', runId);
      return { events: [...(await tx.runs.events(runId, afterSeq))] };
    });
  }
}
