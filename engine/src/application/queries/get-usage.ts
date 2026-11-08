import {
  TERMINAL_STAGES,
  USAGE_DEFAULT_WINDOW_DAYS,
  USAGE_MAX_WINDOW_DAYS,
  type UsageQuery,
  type UsageReport,
  type UsageRow,
} from '@jarvis/shared';
import { InvalidInputError } from '../errors.js';
import type { Clock } from '../ports/clock.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

const DAY_MS = 86_400_000;

/**
 * `GET /api/usage`: what runs cost over a window, grouped by UTC day, session, task or model.
 * The window is `[from, to)` on `started_at`; `to` defaults to now and `from` to seven days before `to`.
 * The grouping happens in the database, so the cost of a request does not grow with the number of runs.
 */
export class GetUsage {
  constructor(private readonly deps: { readonly uow: UnitOfWork; readonly clock: Clock }) {}

  async execute(query: UsageQuery): Promise<UsageReport> {
    const to = Date.parse(query.to ?? this.deps.clock.now());
    const from =
      query.from === undefined ? to - USAGE_DEFAULT_WINDOW_DAYS * DAY_MS : Date.parse(query.from);
    if (from >= to) throw new InvalidInputError('`from` must be before `to`.');
    if (to - from > USAGE_MAX_WINDOW_DAYS * DAY_MS) {
      throw new InvalidInputError(
        `The window may not be wider than ${USAGE_MAX_WINDOW_DAYS} days.`,
      );
    }
    const window = { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
    const { rows, total } = await this.deps.uow.run((tx) =>
      tx.runs.usageReport(window, query.groupBy),
    );
    return {
      ...window,
      groupBy: query.groupBy,
      rows: rows.map(({ stage, ...row }): UsageRow => {
        if (stage === undefined) return row;
        const closed = (TERMINAL_STAGES as readonly string[]).includes(stage);
        return { ...row, stage, status: closed ? 'closed' : 'open' };
      }),
      total,
    };
  }
}
