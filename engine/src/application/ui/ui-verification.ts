import { join } from 'node:path';
import {
  UiCheckReportSchema,
  type EnvironmentPlan,
  type ToolInput,
  type UiCheckReport,
} from '@jarvis/shared';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { BranchPublisher } from '../ports/branch-publisher.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { DevServerManager } from '../ports/dev-server.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { UiBrowser } from '../ports/ui-browser.js';
import type { RunIdentity } from '../run-identity.js';
import type { TaskDeps } from '../tasks/deps.js';
import { loadWorkerTask } from '../tasks/guards.js';
import { transact } from '../transaction.js';
import { ForbiddenError } from '../errors.js';
import type { StartDevServer } from './start-dev-server.js';

interface Check {
  readonly id: string;
  readonly identity: RunIdentity;
  readonly headSha: string;
  cancelled: boolean;
  stopped: boolean;
  activity: number;
  error: boolean;
  report?: UiCheckReport;
  evidence: Set<string>;
  secrets: readonly string[];
  timer?: ReturnType<typeof setTimeout>;
}

interface Deps extends TaskDeps {
  readonly ids: IdGenerator;
  readonly start: StartDevServer;
  readonly devServers: DevServerManager;
  readonly branchPublisher: BranchPublisher;
  readonly artifacts: ArtifactStore;
  readonly browser: UiBrowser;
  readonly config: ConfigProvider;
  readonly redact?: (text: string) => string;
}

/** Serializes environment, browser and verdict operations; startup never counts as a pass. */
export class UiVerification {
  private readonly checks = new Map<string, Check>();
  private readonly endingTasks = new Set<string>();
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: Deps) {}

  private serial<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(taskId) ?? Promise.resolve()).catch(() => {}).then(work);
    this.tails.set(taskId, next);
    void next
      .finally(() => {
        if (this.tails.get(taskId) === next) this.tails.delete(taskId);
      })
      .catch(() => {});
    return next;
  }

  private async task(identity: RunIdentity) {
    return transact(this.deps, async (tx) => {
      const task = await loadWorkerTask(tx, identity);
      const run = await tx.runs.get(identity.runId);
      if (run && run.status !== 'running')
        throw new ForbiddenError('UI check run is no longer active');
      if (!['Reviewing', 'Fixing', 'PR Open'].includes(task.stage)) {
        throw new ForbiddenError('UI verification requires Reviewing, Fixing or PR Open');
      }
      return task;
    });
  }

  private async cleanHead(taskId: string): Promise<string> {
    if ((await this.deps.branchPublisher.status(taskId)).dirtyFiles.length > 0) {
      throw new ForbiddenError('Commit changes before UI verification');
    }
    return this.deps.branchPublisher.headSha(taskId);
  }

  async start(identity: RunIdentity, plan: EnvironmentPlan) {
    const task = await this.task(identity);
    return this.serial(task.id, async () => {
      if (this.endingTasks.has(task.id)) throw new ForbiddenError('Run ended during UI startup');
      await this.task(identity);
      const previous = this.checks.get(task.id);
      if (previous) await this.release(task.id, previous);
      const check: Check = {
        id: this.deps.ids.runId(),
        identity,
        headSha: await this.cleanHead(task.id),
        cancelled: false,
        stopped: false,
        activity: 0,
        error: false,
        evidence: new Set(),
        secrets: [],
      };
      this.checks.set(task.id, check);
      try {
        const result = await this.deps.start.execute(identity, plan);
        if (!result.ok) {
          await this.release(task.id, check);
          return result;
        }
        check.secrets = Object.values(result.revealed ?? {});
        // Cancellation can arrive while Docker is still preparing the application.
        if (check.cancelled || (await this.cleanHead(task.id)) !== check.headSha) {
          throw new Error('Run ended or HEAD changed during environment startup');
        }
        await this.note(task.id, 'ui_check_started', {
          checkId: check.id,
          runId: identity.runId,
          headSha: check.headSha,
        });
        check.timer = setTimeout(
          () => {
            void this.cleanup(task.id).catch((error: unknown) => {
              this.deps.notifiers.logger.error('UI lease cleanup failed', {
                taskId: task.id,
                error: String(error),
              });
            });
          },
          Math.min(
            2_147_483_647,
            Math.max(0, Date.parse(result.lease.expiresAt) - Date.parse(this.deps.clock.now())),
          ),
        );
        check.timer.unref();
        return { ...result, checkId: check.id };
      } catch (error) {
        check.error = true;
        await this.release(task.id, check);
        throw error;
      }
    });
  }

  private owned(identity: RunIdentity, checkId: string): Check {
    const check = identity.taskId ? this.checks.get(identity.taskId) : undefined;
    if (
      !check ||
      check.id !== checkId ||
      check.identity.runId !== identity.runId ||
      check.cancelled
    ) {
      throw new ForbiddenError('Unknown, ended or foreign UI check');
    }
    return check;
  }

  async browse(identity: RunIdentity, input: ToolInput<'ui_browser'>) {
    const task = await this.task(identity);
    return this.serial(task.id, async () => {
      await this.task(identity);
      const check = this.owned(identity, input.checkId);
      const lease = this.deps.devServers.current();
      if (
        check.stopped ||
        check.report ||
        lease?.taskId !== task.id ||
        Date.parse(lease.expiresAt) <= Date.parse(this.deps.clock.now())
      ) {
        throw new ForbiddenError('UI browser requires an active check lease');
      }
      if ((await this.cleanHead(task.id)) !== check.headSha)
        throw new ForbiddenError('UI check HEAD changed');
      if (
        input.tool === 'browser_take_screenshot' &&
        check.evidence.size >= this.deps.config.current().ui.maxScreenshots
      ) {
        throw new ForbiddenError('UI screenshot limit reached');
      }
      try {
        const result = await this.deps.browser.call({
          runId: identity.runId,
          outputDir: join(this.deps.artifacts.dirFor(task.id), 'screenshots', check.id),
          tool: input.tool,
          arguments: input.arguments,
        });
        if (result.isError) check.error = true;
        else if (!['list', 'browser_close'].includes(input.tool)) check.activity++;
        for (const file of result.evidence ?? []) check.evidence.add(file);
        return result;
      } catch (error) {
        check.error = true;
        throw error;
      }
    });
  }

  private async release(taskId: string, check: Check): Promise<void> {
    if (check.timer) clearTimeout(check.timer);
    // Attempt both releases even if one fails. A failure permanently disqualifies this attempt.
    const results = await Promise.allSettled([
      this.deps.browser.close(check.identity.runId),
      this.deps.devServers.stop(taskId),
    ]);
    check.stopped = results.every((result) => result.status === 'fulfilled');
    if (!check.stopped) {
      check.error = true;
      await this.note(taskId, 'ui_cleanup_failed', {
        checkId: check.id,
        runId: check.identity.runId,
      });
      throw new Error('UI cleanup failed; this check cannot pass');
    }
  }

  async stop(identity: RunIdentity): Promise<{ stopped: boolean }> {
    const task = await transact(this.deps, (tx) => loadWorkerTask(tx, identity));
    return this.serial(task.id, async () => {
      const held = this.deps.devServers.current()?.taskId === task.id;
      const check = this.checks.get(task.id);
      if (check && check.identity.runId !== identity.runId)
        throw new ForbiddenError('Foreign UI lease');
      if (check) await this.release(task.id, check);
      else await this.deps.devServers.stop(task.id);
      return { stopped: held };
    });
  }

  /** Called on run exit and lease expiry, including while a startup call is pending. */
  async cleanup(taskId: string): Promise<void> {
    this.endingTasks.add(taskId);
    const check = this.checks.get(taskId);
    if (check) check.cancelled = true;
    await this.serial(taskId, async () => {
      const current = this.checks.get(taskId);
      try {
        if (current) await this.release(taskId, current);
        else await this.deps.devServers.stop(taskId);
      } finally {
        this.checks.delete(taskId);
        this.endingTasks.delete(taskId);
      }
    });
  }

  async closeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.checks.keys()].map((id) => this.cleanup(id)));
    if (results.some((r) => r.status === 'rejected'))
      throw new Error('UI cleanup failed at shutdown');
  }

  async report(identity: RunIdentity, raw: UiCheckReport) {
    const input = UiCheckReportSchema.parse(raw);
    const task = await this.task(identity);
    return this.serial(task.id, async () => {
      await this.task(identity);
      const headSha = await this.cleanHead(task.id);
      const check = input.checkId ? this.owned(identity, input.checkId) : undefined;
      if (check && check.headSha !== headSha) throw new ForbiddenError('UI check HEAD changed');
      if (input.scenarios.length > this.deps.config.current().ui.maxScenarios) {
        throw new ForbiddenError('UI scenario limit reached');
      }
      if (check?.report) {
        if (JSON.stringify(check.report) !== JSON.stringify(input))
          throw new ForbiddenError('UI check already completed');
        return { ok: true, checkId: check.id, status: input.status, headSha: check.headSha };
      }
      const serialized = JSON.stringify(input);
      if (
        (this.deps.redact && this.deps.redact(serialized) !== serialized) ||
        this.checks
          .get(task.id)
          ?.secrets.some((secret) => secret.length > 0 && serialized.includes(secret))
      ) {
        throw new ForbiddenError('UI reports must not contain credentials');
      }
      if (input.status !== 'unavailable') {
        if (
          !check ||
          check.headSha !== headSha ||
          !check.stopped ||
          check.activity === 0 ||
          check.error
        ) {
          throw new ForbiddenError(
            'No confirmed browser activity, cleanup or current HEAD for this verdict',
          );
        }
        for (const scenario of input.scenarios) {
          for (const path of scenario.evidence) {
            if (!check.evidence.has(path))
              throw new ForbiddenError('Evidence belongs to another check');
            const blob = await this.deps.artifacts.readImage(task.id, path);
            if (blob.sizeBytes === 0) throw new ForbiddenError('Empty UI evidence');
            if (blob.sizeBytes > this.deps.config.current().ui.maxImageMb * 1024 * 1024) {
              throw new ForbiddenError('UI evidence exceeds image size limit');
            }
          }
        }
      }
      const checkId = check?.id ?? this.deps.ids.runId();
      await this.note(task.id, 'ui_check_completed', {
        ...input,
        checkId,
        runId: identity.runId,
        headSha,
      });
      if (check) check.report = input;
      return { ok: true, checkId, status: input.status, headSha };
    });
  }

  private note(taskId: string, type: string, data: Record<string, unknown>) {
    return transact(this.deps, async (tx) => {
      const check = this.checks.get(taskId);
      if (type === 'ui_check_completed' && check?.cancelled) throw new ForbiddenError('Run ended');
      if (type === 'ui_check_completed' && typeof data['runId'] === 'string') {
        const task = await tx.tasks.get(taskId);
        const run = await tx.runs.get(data['runId']);
        if (
          !task ||
          !['Reviewing', 'Fixing', 'PR Open'].includes(task.stage) ||
          (run && run.status !== 'running')
        ) {
          throw new ForbiddenError('UI check run is no longer active');
        }
      }
      return this.deps.writer.note(tx, taskId, type, 'system', data);
    });
  }
}
