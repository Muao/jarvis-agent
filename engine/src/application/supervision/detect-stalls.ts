import type { RunEvent } from '@jarvis/shared';
import { elapsedMs, isStalled, MS_PER_MINUTE, type Run } from '../../domain/index.js';
import type { BodyOf } from '../conversation/message-bodies.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { TaskDeps } from '../tasks/deps.js';
import { transact } from '../transaction.js';

function lastActivity(event: RunEvent | null): string {
  if (event === null) return 'nothing yet';
  if (event.kind === 'tool_use') return `tool ${event.payload.name}`;
  if (event.kind === 'permission') return `permission for ${event.payload.toolName}`;
  return event.kind.replace('_', ' ');
}

const who = (run: Run): string =>
  run.taskId === null ? 'The dispatcher' : `The worker of ${run.taskId}`;

/**
 * DSP-09: a live run that produced no event for `limits.stallMinutes`, or waits that long for the
 * owner's permission answer, gets one warning in its thread. The same silence is not reported twice;
 * a new event re-arms the warning. Called by a timer (T13).
 */
export class DetectStalls {
  /** Run id -> the time of the last event when it was warned about. */
  private readonly warnedRuns = new Map<string, string>();
  private readonly warnedPermissions = new Set<string>();

  constructor(private readonly deps: TaskDeps & { readonly config: ConfigProvider }) {}

  async execute(): Promise<void> {
    const { uow, clock, config } = this.deps;
    const { limits } = config.current();
    const now = clock.now();
    const { runs, pending } = await uow.run(async (tx) => ({
      runs: await Promise.all(
        (await tx.runs.listRunning()).map(async (run) => ({
          run,
          last: await tx.runs.lastEvent(run.id),
        })),
      ),
      pending: await tx.permissions.listPending(),
    }));
    this.forget(new Set(runs.map(({ run }) => run.id)), new Set(pending.map((r) => r.id)));

    const waiting = new Set<string>();
    for (const request of pending) {
      const run = runs.find((r) => r.run.id === request.runId)?.run;
      if (run === undefined || !isStalled(request.requestedAt, now, limits)) continue;
      waiting.add(run.id);
      if (this.warnedPermissions.has(request.id)) continue;
      this.warnedPermissions.add(request.id);
      const minutes = Math.floor(elapsedMs(request.requestedAt, now) / MS_PER_MINUTE);
      await this.warn(
        run,
        `${who(run)} has been waiting ${minutes} min for your answer on ${request.tool}. Without an answer the request is denied when it times out.`,
      );
    }

    for (const { run, last } of runs) {
      if (waiting.has(run.id)) continue;
      const lastAt = last?.at ?? run.startedAt;
      if (!isStalled(lastAt, now, limits) || this.warnedRuns.get(run.id) === lastAt) continue;
      this.warnedRuns.set(run.id, lastAt);
      const minutes = Math.floor(elapsedMs(lastAt, now) / MS_PER_MINUTE);
      await this.warn(
        run,
        `${who(run)} has produced no events for ${minutes} min. Last activity: ${lastActivity(last)}. You can stop the run in the console.`,
      );
    }
  }

  /** Runs and requests that ended can never be warned about again; drop their marks. */
  private forget(liveRuns: ReadonlySet<string>, pendingRequests: ReadonlySet<string>): void {
    for (const id of this.warnedRuns.keys()) if (!liveRuns.has(id)) this.warnedRuns.delete(id);
    for (const id of this.warnedPermissions) {
      if (!pendingRequests.has(id)) this.warnedPermissions.delete(id);
    }
  }

  private async warn(run: Run, text: string): Promise<void> {
    const body: BodyOf<'system'> = { text };
    await transact(this.deps, async (tx, outbox) => {
      await this.deps.messages.post(tx, outbox, {
        threadId: run.threadId,
        taskId: run.taskId,
        kind: 'system',
        body,
      });
      if (run.taskId !== null) {
        await this.deps.writer.note(tx, run.taskId, 'run_stalled', 'system', { runId: run.id });
      }
    });
  }
}
