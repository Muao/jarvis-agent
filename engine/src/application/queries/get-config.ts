import type { ConfigDto } from '@jarvis/shared';
import type { Clock } from '../ports/clock.js';
import type { ConfigProvider, ConfigStatus } from '../ports/config-provider.js';
import type { ProfileFiles } from '../ports/profile-files.js';
import type { RepoInfo } from '../ports/repo-info.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { usageWindowStart } from '../runs/usage-window.js';
import { usageOf } from './usage.js';

/**
 * `GET /api/config`: the limits in force, the usage against them, what the target repo's `AGENTS.md`
 * says and the profile files. When the file on disk was rejected the answer is the error instead
 * (LIM-02): the engine keeps running with the last good config, but the owner must see the problem.
 */
export class GetConfig {
  constructor(
    private readonly deps: {
      readonly uow: UnitOfWork;
      readonly clock: Clock;
      readonly config: ConfigProvider;
      readonly status: ConfigStatus;
      readonly repoInfo: RepoInfo;
      readonly profile: ProfileFiles;
    },
  ) {}

  async execute(): Promise<ConfigDto> {
    const { status, clock } = this.deps;
    const rejected = status.lastError();
    if (rejected !== null) {
      return {
        valid: false,
        path: status.path(),
        errors: rejected.split('\n').filter((line) => line.trim() !== ''),
      };
    }
    const config = this.deps.config.current();
    const now = clock.now();
    const usage = await this.deps.uow.run(async (tx) =>
      tx.runs.usageSince(await usageWindowStart(tx, now)),
    );
    const repository = await this.deps.repoInfo.commands(config.repo.path);
    const spent = await this.deps.uow.run(async (tx) =>
      tx.runs.tokensSince(await usageWindowStart(tx, now)),
    );
    return {
      valid: true,
      path: status.path(),
      loadedAt: status.loadedAt() ?? now,
      config,
      usage: {
        ...usageOf(spent, config.limits, now),
        byRole: usage.byRole,
        byTask: [...usage.byTask],
      },
      repository: { ...repository, checkCommands: [...repository.checkCommands] },
      profile: await this.deps.profile.read(),
    };
  }
}
