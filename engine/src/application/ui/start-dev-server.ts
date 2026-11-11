import { planCredentialViolations, type EnvironmentPlan } from '@jarvis/shared';
import { ForbiddenError } from '../errors.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { DevServerManager, DevServerRefused, DevServerResult } from '../ports/dev-server.js';
import type { WorktreeManager } from '../ports/worktree-manager.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from '../tasks/deps.js';
import { loadWorkerTask } from '../tasks/guards.js';
import { worktreeFor } from '../tasks/worktree-for.js';
import { transact } from '../transaction.js';
import type { TrustPullRequestHead } from './trust-pull-request-head.js';

export interface StartDevServerDeps extends TaskDeps {
  readonly config: ConfigProvider;
  readonly devServers: DevServerManager;
  readonly worktrees: WorktreeManager;
  /** ADR-0018: decides whether this pull request's code may run at all. */
  readonly trustHead: TrustPullRequestHead;
}

const UI_CHECK_STAGES: readonly string[] = ['Reviewing', 'Fixing', 'PR Open'];

/** Runs whose attempt counts are remembered; older ones are forgotten first. */
const REMEMBERED_RUNS = 200;

/**
 * ADR-0014, ADR-0026: the worker's `start_dev_server(plan)`. The worker works out from the target
 * repository how to bring it up; the engine runs that plan in disposable containers and holds the
 * lease. The plan may not carry a literal credential, and a run gets `ui.maxStartAttempts` tries.
 * Allowed in `Reviewing` and, for a fix or an owner's request after the PR, in `Fixing` and `PR Open`.
 */
export class StartDevServer {
  private readonly attempts = new Map<string, number>();

  constructor(private readonly deps: StartDevServerDeps) {}

  async execute(identity: RunIdentity, plan: EnvironmentPlan): Promise<DevServerResult> {
    const { task, cwd } = await transact(this.deps, async (tx) => {
      const found = await loadWorkerTask(tx, identity);
      if (!UI_CHECK_STAGES.includes(found.stage)) {
        throw new ForbiddenError(
          `the dev server is for the UI check in Reviewing, Fixing or PR Open; task ${found.id} is ${found.stage}`,
        );
      }
      const worktree = await worktreeFor(this.deps.worktrees, found);
      return { task: found, cwd: worktree.path };
    });

    const refused = (result: DevServerRefused): Promise<DevServerRefused> =>
      transact(this.deps, async (tx) => {
        await this.deps.writer.note(tx, task.id, 'dev_server_refused', 'system', {
          reason: result.reason,
          detail: result.detail,
          ...(result.step === undefined ? {} : { step: result.step }),
        });
        return result;
      });

    const violations = planCredentialViolations(plan);
    if (violations.length > 0) {
      return refused({ ok: false, reason: 'invalid_plan', detail: violations.join('; ') });
    }

    const allowed = this.deps.config.current().ui.maxStartAttempts;
    const used = this.attempts.get(identity.runId) ?? 0;
    if (used >= allowed) {
      return refused({
        ok: false,
        reason: 'attempts_exhausted',
        detail: `This run already tried ${used} plans (ui.maxStartAttempts). Stop, and report what you tried and what failed.`,
      });
    }

    // ADR-0018: asked before anything of this pull request runs, and it can block on the owner.
    const trust = await this.deps.trustHead.decide(identity, task, plan);
    if (!trust.trusted) {
      return refused({ ok: false, reason: 'untrusted_head', detail: trust.detail });
    }

    this.countAttempt(identity.runId, used + 1);
    const result = await this.deps.devServers.start(task.id, cwd, plan);
    if (!result.ok) return refused(result);

    await transact(this.deps, async (tx) => {
      // The plan is safe to keep verbatim: it holds markers and references, never a secret.
      await this.deps.writer.note(tx, task.id, 'dev_server_started', 'system', {
        baseUrl: result.lease.baseUrl,
        expiresAt: result.lease.expiresAt,
        plan,
      });
    });
    return result;
  }

  private countAttempt(runId: string, count: number): void {
    this.attempts.delete(runId);
    this.attempts.set(runId, count);
    if (this.attempts.size > REMEMBERED_RUNS) {
      const oldest = this.attempts.keys().next().value;
      if (oldest !== undefined) this.attempts.delete(oldest);
    }
  }
}
