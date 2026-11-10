import type { UsageDto } from '@jarvis/shared';
import type { Clock } from '../ports/clock.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { EventBus } from '../ports/event-bus.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { usageOf } from '../queries/usage.js';
import type { RunScheduler } from './run-scheduler.js';
import { usageWindowStart } from './usage-window.js';

/**
 * `POST /api/usage/reset` (LIM-04): from now on "spent today" counts only runs that start after
 * this moment. Queued work starts at once and a later exhaustion is announced again.
 */
export class ResetDailyUsage {
  constructor(
    private readonly deps: {
      readonly uow: UnitOfWork;
      readonly clock: Clock;
      readonly config: ConfigProvider;
      readonly events: EventBus;
      readonly scheduler: Pick<RunScheduler, 'budgetWasReset'>;
    },
  ) {}

  async execute(): Promise<UsageDto> {
    const { uow, clock, config, events, scheduler } = this.deps;
    const now = clock.now();
    const spent = await uow.run(async (tx) => {
      await tx.budgetResets.append(now);
      return tx.runs.costSince(await usageWindowStart(tx, now));
    });
    await scheduler.budgetWasReset();
    await events.publish({ type: 'overview' });
    return usageOf(spent, config.current().limits, now);
  }
}
