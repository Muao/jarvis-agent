import type { Health } from '@jarvis/shared';
import type { Clock } from '../ports/clock.js';
import type { ConnectionChecks } from '../ports/connection-checks.js';
import type { DatabasePing } from '../ports/database-ping.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

export const HEALTH_DEADLINE_MS = 3000;

/**
 * `GET /api/health`: the database answers a `SELECT 1`, and `claude` is whatever the last probe found.
 * It never runs a probe itself, so a health call stays cheap; `unknown` until the first probe.
 */
export class GetHealth {
  constructor(
    private readonly deps: {
      readonly database: DatabasePing;
      readonly checks: Pick<ConnectionChecks, 'last'>;
      readonly uow: UnitOfWork;
      readonly clock: Clock;
      readonly startedAt: string;
      readonly version: string;
    },
  ) {}

  async execute(): Promise<Health> {
    const { checks, clock, startedAt, version } = this.deps;
    const { databaseOk, activeRuns } = await this.database();
    const cached = checks.last('claude')?.status;
    const claude: Health['claude'] =
      cached === 'ok' || cached === 'warning' || cached === 'failed' ? cached : 'unknown';
    const status: Health['status'] = !databaseOk
      ? 'failed'
      : claude === 'failed' || claude === 'warning'
        ? 'degraded'
        : 'ok';
    const uptimeSeconds = Math.max(
      0,
      Math.floor((Date.parse(clock.now()) - Date.parse(startedAt)) / 1000),
    );
    return {
      status,
      uptimeSeconds,
      database: databaseOk ? 'ok' : 'failed',
      claude,
      activeRuns,
      version,
    };
  }

  /** The ping and the run count under one deadline: a database that does not answer is a failed one. */
  private async database(): Promise<{ databaseOk: boolean; activeRuns: number }> {
    const { database, uow } = this.deps;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<{ databaseOk: false; activeRuns: 0 }>((resolve) => {
      timer = setTimeout(() => resolve({ databaseOk: false, activeRuns: 0 }), HEALTH_DEADLINE_MS);
    });
    const answer = (async () => {
      try {
        await database.ping();
        const running = await uow.run((tx) => tx.runs.listRunning());
        return { databaseOk: true, activeRuns: running.length };
      } catch {
        return { databaseOk: false, activeRuns: 0 };
      }
    })();
    try {
      return await Promise.race([answer, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}
