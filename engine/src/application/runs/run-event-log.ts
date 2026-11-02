import type { RunEvent } from '@jarvis/shared';
import type { Clock } from '../ports/clock.js';
import type { EventBus } from '../ports/event-bus.js';
import type { RunEventBody } from '../ports/agent-runner.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** Stores a run's events and pushes each one to the live console (ADM-03). */
export class RunEventLog {
  constructor(
    private readonly deps: {
      readonly uow: UnitOfWork;
      readonly events: EventBus;
      readonly clock: Clock;
    },
  ) {}

  async append(runId: string, body: RunEventBody): Promise<RunEvent> {
    const { uow, events, clock } = this.deps;
    const stored = await uow.run((tx) => tx.runs.appendEvent(runId, body, clock.now()));
    await events.publish({ type: 'run_event', id: runId, data: stored });
    return stored;
  }
}
