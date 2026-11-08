import { ForbiddenError } from '../errors.js';
import type { DevServerManager, DevServerResult } from '../ports/dev-server.js';
import type { WorktreeManager } from '../ports/worktree-manager.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from '../tasks/deps.js';
import { loadWorkerTask } from '../tasks/guards.js';
import { worktreeFor } from '../tasks/worktree-for.js';
import { transact } from '../transaction.js';
import type { TrustPullRequestHead } from './trust-pull-request-head.js';

export interface StartDevServerDeps extends TaskDeps {
  readonly devServers: DevServerManager;
  readonly worktrees: WorktreeManager;
  /** ADR-0018: decides whether this pull request's code may run at all. */
  readonly trustHead: TrustPullRequestHead;
}

/**
 * ADR-0014: the worker's `start_dev_server`. The engine runs `ui.devCommand` in the task's own
 * worktree and holds the lease; the tool takes no arguments, so no model picks the command, the
 * URL or how long the server lives. Allowed in `Reviewing` only — that is where the UI check runs.
 */
export class StartDevServer {
  constructor(private readonly deps: StartDevServerDeps) {}

  async execute(identity: RunIdentity): Promise<DevServerResult> {
    const { task, cwd } = await transact(this.deps, async (tx) => {
      const found = await loadWorkerTask(tx, identity);
      if (found.stage !== 'Reviewing') {
        throw new ForbiddenError(
          `the dev server is for the UI check in Reviewing; task ${found.id} is ${found.stage}`,
        );
      }
      const worktree = await worktreeFor(this.deps.worktrees, found);
      return { task: found, cwd: worktree.path };
    });

    // ADR-0018: asked before anything of this pull request runs, and it can block on the owner.
    const trust = await this.deps.trustHead.decide(identity, task);
    if (!trust.trusted) {
      const refused: DevServerResult = {
        ok: false,
        reason: 'untrusted_head',
        detail: trust.detail,
      };
      await transact(this.deps, async (tx) => {
        await this.deps.writer.note(tx, task.id, 'dev_server_refused', 'system', {
          reason: refused.reason,
          detail: refused.detail,
        });
      });
      return refused;
    }

    const result = await this.deps.devServers.start(task.id, cwd);

    await transact(this.deps, async (tx) => {
      await this.deps.writer.note(
        tx,
        task.id,
        result.ok ? 'dev_server_started' : 'dev_server_refused',
        'system',
        result.ok
          ? { baseUrl: result.lease.baseUrl, expiresAt: result.lease.expiresAt }
          : { reason: result.reason, detail: result.detail },
      );
    });

    return result;
  }
}
