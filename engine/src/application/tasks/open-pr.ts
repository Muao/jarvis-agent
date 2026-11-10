import { join } from 'node:path';
import type { TaskStage } from '@jarvis/shared';
import {
  attachPullRequest,
  pathsDefiningChecks,
  recordCheckFailure,
  recordCheckPass,
  resolveCheckCommands,
  type Task,
  type TaskEvent,
} from '../../domain/index.js';
import { redOnBase } from './base-comparison.js';
import { ForbiddenError } from '../errors.js';
import { newWatch } from '../code-host/new-watch.js';
import type { BodyOf } from '../conversation/message-bodies.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { BranchPublisher, BranchStatus } from '../ports/branch-publisher.js';
import type { CheckResult, CheckRunner } from '../ports/check-runner.js';
import type { CodeHost, RepoTarget } from '../ports/code-host.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { RepoInfo } from '../ports/repo-info.js';
import type { RepoResolver } from '../ports/repo-resolver.js';
import type { WorktreeManager } from '../ports/worktree-manager.js';
import type { LiveRuns } from '../runs/live-runs.js';
import type { RunEventLog } from '../runs/run-event-log.js';
import type { RunIdentity } from '../run-identity.js';
import { transact } from '../transaction.js';
import type { TaskDeps } from './deps.js';
import { loadWorkerTask } from './guards.js';
import { worktreeFor } from './worktree-for.js';

export interface OpenPrInput {
  readonly title?: string;
  readonly body?: string;
}

/** What a check looked like to the worker: the result plus nothing the engine keeps to itself. */
export type CheckResultDto = CheckResult;

export type OpenPrRefusal =
  | 'wrong_stage'
  | 'already_running'
  | 'dirty_tree'
  | 'no_commits'
  | 'no_checks_declared'
  | 'checks_unavailable'
  | 'push_rejected'
  | 'host_unconfigured'
  | 'host_error'
  | 'repo_unknown'
  | 'title_and_body_required';

export type OpenPrResult =
  | {
      readonly ok: true;
      readonly number: number;
      readonly url: string;
      readonly headSha: string;
      readonly created: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: OpenPrRefusal;
      readonly detail: string;
      readonly files?: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: 'checks_failed';
      readonly attempt: number;
      readonly max: number;
      readonly results: readonly CheckResultDto[];
      /** Red on the merge base as well: not the task's to fix. */
      readonly preexisting: readonly string[];
      /** Relative to the task's artifacts directory. */
      readonly logPath: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'checks_exhausted';
      readonly max: number;
      readonly results: readonly CheckResultDto[];
      readonly logPath: string;
    };

export interface OpenPrDeps extends TaskDeps {
  readonly config: ConfigProvider;
  readonly repoInfo: RepoInfo;
  readonly worktrees: WorktreeManager;
  readonly checkRunner: CheckRunner;
  readonly branchPublisher: BranchPublisher;
  readonly codeHost: CodeHost;
  readonly artifacts: ArtifactStore;
  readonly repos: RepoResolver;
  readonly eventLog: RunEventLog;
  readonly liveRuns: LiveRuns;
  /**
   * False when the engine has no GitHub token: nothing could be pushed, so the gate is not run
   * either. Composition root only; tests leave it out.
   */
  readonly hostConfigured?: boolean;
}

/** The stages `open_pr` may be called from (ADR-0022). `Verifying` is what the engine itself sets. */
const ALLOWED_STAGES: readonly TaskStage[] = ['Implementing', 'Verifying', 'Reviewing', 'Fixing'];

const sha7 = (sha: string): string => sha.slice(0, 7);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

function lastIndexOfType(journal: readonly TaskEvent[], type: string): number {
  for (let i = journal.length - 1; i >= 0; i -= 1) if (journal[i]?.type === type) return i;
  return -1;
}

/** The commands the owner's approval fixed: the latest `checks_fixed` row (ADR-0022). */
function frozenCommands(journal: readonly TaskEvent[]): string[] | null {
  const at = lastIndexOfType(journal, 'checks_fixed');
  const commands = strings(journal[at]?.data['commands']);
  return at >= 0 && commands.length > 0 ? commands : null;
}

function latestFixedSource(journal: readonly TaskEvent[]): unknown {
  return journal[lastIndexOfType(journal, 'checks_fixed')]?.data['source'];
}

/**
 * A green gate for exactly this commit that no later approval has invalidated: the push or the
 * host failed after it, so the next call must not run everything again.
 */
function cachedGreen(journal: readonly TaskEvent[], headSha: string): GreenGate | null {
  const fixedAt = lastIndexOfType(journal, 'checks_fixed');
  for (let i = journal.length - 1; i > fixedAt; i -= 1) {
    const event = journal[i];
    if (event?.type === 'checks_passed' && event.data['headSha'] === headSha) {
      const results = event.data['results'];
      const baseSha = event.data['baseSha'];
      return {
        results: Array.isArray(results) ? (results as CheckResult[]) : [],
        preexisting: strings(event.data['preexisting']),
        baseSha: typeof baseSha === 'string' ? baseSha : null,
      };
    }
  }
  return null;
}

/** A passed gate: what ran, and which of the red commands main fails as well. */
interface GreenGate {
  readonly results: readonly CheckResult[];
  readonly preexisting: readonly string[];
  readonly baseSha: string | null;
}

const isRed = (result: CheckResult): boolean => result.exitCode !== 0 || result.timedOut;

function duration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** The commands red on the merge base too: named, with the tail of their output folded away. */
function failsOnMain(input: {
  readonly results: readonly CheckResult[];
  readonly preexisting: readonly string[];
  readonly baseSha: string | null;
}): string {
  const base = input.baseSha === null ? 'main' : sha7(input.baseSha);
  const items = input.preexisting.map((command) => {
    const tail = input.results.find((r) => r.command === command)?.tail ?? '';
    const lastLines = tail.split('\n').slice(-20).join('\n');
    return [
      `- ✗ \`${command}\` — red on ${base} as well; CI decides.`,
      `<details><summary>output</summary>\n\n\`\`\`\n${lastLines}\n\`\`\`\n\n</details>`,
    ].join('\n\n');
  });
  return ['## Fails on main too', ...items].join('\n\n');
}

/** The engine's own claim, appended to the worker's PR text: what ran, how it ended, on which commit. */
function pullRequestBody(input: {
  readonly body: string;
  readonly results: readonly CheckResult[];
  readonly headSha: string;
  readonly changedFiles: readonly string[];
  readonly preexisting: readonly string[];
  readonly baseSha: string | null;
}): string {
  const lines = input.results.map(
    (r) =>
      `- ${isRed(r) ? '✗' : '✓'} \`${r.command}\` — ${duration(r.durationMs)} (${sha7(input.headSha)})`,
  );
  const sections = [input.body.trimEnd(), '## Checks (run by Jarvis)', lines.join('\n')];
  if (input.preexisting.length > 0) sections.push(failsOnMain(input));
  const defining = pathsDefiningChecks(input.changedFiles);
  if (defining.length > 0) {
    sections.push(
      `Files that define the checks changed in this PR: ${defining.map((f) => `\`${f}\``).join(', ')}`,
    );
  }
  return sections.join('\n\n');
}

/**
 * ADR-0022: the only door to `PR Open` for a `build` task. The engine runs the owner-approved
 * check commands on the worktree's commit, refuses on red, pushes exactly that commit and opens the
 * draft PR itself. Nothing here trusts a claim of the worker: it supplies a title and a body, never
 * a command, a branch, a base or a sha.
 *
 * No database transaction is held while the gate or the push runs: the task is read in one, the
 * outcome written in the next (the `CommentOnPr` pattern). The in-memory `running` set is the lock.
 */
export class OpenPr {
  private readonly running = new Set<string>();

  constructor(private readonly deps: OpenPrDeps) {}

  async execute(identity: RunIdentity, input: OpenPrInput): Promise<OpenPrResult> {
    // Only a title and a body exist as input; anything else the caller sent is not read.
    const { title, body } = input;
    const taskId = identity.taskId;
    if (taskId === undefined || identity.role !== 'worker') {
      throw new ForbiddenError('this tool is only available to a worker run of a task');
    }
    if (this.running.has(taskId)) {
      return {
        ok: false,
        reason: 'already_running',
        detail: 'The checks for this task are already running; wait for that call to return.',
      };
    }
    this.running.add(taskId);
    const abort = new AbortController();
    const unsubscribe = this.deps.liveRuns.onEnd(identity.runId, () => abort.abort());
    try {
      return await this.run(identity, { title, body }, abort.signal);
    } finally {
      unsubscribe();
      this.running.delete(taskId);
    }
  }

  private async run(
    identity: RunIdentity,
    input: OpenPrInput,
    signal: AbortSignal,
  ): Promise<OpenPrResult> {
    const { deps } = this;
    const { task, journal } = await transact(deps, async (tx, outbox) => {
      // DSP-04: a push from `PR Open` is the owner's request; the task moves to `Fixing` first.
      const found = await deps.writer.reopenForPush(tx, outbox, await loadWorkerTask(tx, identity));
      return { task: found, journal: await tx.journal.list(found.id) };
    });

    if (task.kind !== 'build' || !ALLOWED_STAGES.includes(task.stage)) {
      return {
        ok: false,
        reason: 'wrong_stage',
        detail: `open_pr works in Implementing, Reviewing, Fixing or PR Open of a build task; this task is ${task.kind} in ${task.stage}.`,
      };
    }
    if (task.pr === null && (input.title === undefined || input.body === undefined)) {
      return {
        ok: false,
        reason: 'title_and_body_required',
        detail: 'The first open_pr of a task needs both `title` and `body`.',
      };
    }
    if (deps.hostConfigured === false) {
      return {
        ok: false,
        reason: 'host_unconfigured',
        detail: 'GitHub is not configured: set GITHUB_TOKEN in ~/.jarvis/.env and restart Jarvis.',
      };
    }
    const repo = task.targetRepo ?? deps.repos.defaultRepo();
    if (repo === null) {
      return {
        ok: false,
        reason: 'repo_unknown',
        detail: 'The repository of this task is not a GitHub repository Jarvis knows.',
      };
    }

    const worktree = await worktreeFor(deps.worktrees, task);
    const status = await deps.branchPublisher.status(task.id);
    if (status.dirtyFiles.length > 0) {
      return {
        ok: false,
        reason: 'dirty_tree',
        detail:
          'The worktree has uncommitted changes. The checks verify the commit that gets pushed: commit (or remove) these files, then call open_pr again.',
        files: [...status.dirtyFiles],
      };
    }
    if (status.commitsAhead === 0) {
      return {
        ok: false,
        reason: 'no_commits',
        detail:
          'There is no commit beyond the base branch yet: commit your work, then call open_pr.',
      };
    }
    const headSha = await deps.branchPublisher.headSha(task.id);

    const commands = await this.commandsFor(task, journal, worktree.path, repo);
    if (commands === null) {
      return {
        ok: false,
        reason: 'no_checks_declared',
        detail:
          'No check commands were fixed for this task and the repository names none in AGENTS.md. Ask the owner which commands to run.',
      };
    }

    // The commands may have just been refreshed: a green on the old list must not be reused, so
    // the cache is judged on the journal as it is now, after the latest `checks_fixed`.
    const current = await transact(deps, (tx) => tx.journal.list(task.id));
    const cached = cachedGreen(current, headSha);
    let green: GreenGate;
    if (cached === null) {
      const gate = await this.gate({
        identity,
        task,
        commands,
        headSha,
        worktreePath: worktree.path,
        signal,
      });
      if ('refusal' in gate) return gate.refusal;
      green = gate;
    } else {
      green = cached;
    }

    // The tree must still be what was checked. The pushed sha is the one that ran either way.
    const after = await this.settled(task.id, headSha);
    if (after.refusal !== null) return after.refusal;

    return this.publish({ identity, task, repo, headSha, green, status: after.status, input });
  }

  /** The frozen list, or the one `AGENTS.md` gives a task approved before ADR-0022 (journalled). */
  private async commandsFor(
    task: Task,
    journal: readonly TaskEvent[],
    worktreePath: string,
    repo: RepoTarget,
  ): Promise<string[] | null> {
    const frozen = frozenCommands(journal);
    if (frozen !== null) return this.refreshed(task, journal, frozen, repo);
    const found = await this.deps.repoInfo.commands(worktreePath);
    const resolved = resolveCheckCommands({ agentsMd: found.checkCommands, proposed: undefined });
    if (!resolved.ok) return null;
    const commands = [...resolved.commands];
    await transact(this.deps, (tx) =>
      this.deps.writer.note(tx, task.id, 'checks_fixed', 'system', {
        commands,
        source: 'agents_md_fallback',
        cardId: null,
      }),
    );
    return commands;
  }

  /**
   * A list the engine found (not the worker) follows main: when main's `AGENTS.md` names other
   * commands, the new list is journalled, announced and used. The file is read from the remote base
   * tip, never from the task's worktree or branch.
   */
  private async refreshed(
    task: Task,
    journal: readonly TaskEvent[],
    frozen: string[],
    repo: RepoTarget,
  ): Promise<string[]> {
    const { deps } = this;
    if (latestFixedSource(journal) === 'worker') return frozen;
    const markdown = await deps.branchPublisher.baseFile({
      taskId: task.id,
      repo,
      path: 'AGENTS.md',
    });
    if (markdown === null) return frozen;
    const fresh = deps.repoInfo.parseCommands(markdown);
    if (
      fresh.length === 0 ||
      (fresh.length === frozen.length && fresh.every((c, i) => c === frozen[i]))
    ) {
      return frozen;
    }
    await transact(deps, async (tx, outbox) => {
      await deps.writer.note(tx, task.id, 'checks_fixed', 'system', {
        commands: fresh,
        source: 'base_refresh',
        cardId: null,
        previous: frozen,
      });
      const body: BodyOf<'system'> = {
        text: `Checks updated from main's AGENTS.md: ${frozen.join(', ')} → ${fresh.join(', ')}.`,
      };
      await deps.messages.post(tx, outbox, {
        threadId: task.threadId,
        taskId: task.id,
        kind: 'system',
        body,
      });
    });
    return fresh;
  }

  /** Runs the gate and writes its outcome. A `refusal` is the whole answer; `results` means green. */
  private async gate(input: {
    readonly identity: RunIdentity;
    readonly task: Task;
    readonly commands: readonly string[];
    readonly headSha: string;
    readonly worktreePath: string;
    readonly signal: AbortSignal;
  }): Promise<GreenGate | { readonly refusal: OpenPrResult }> {
    const { deps } = this;
    const { task, commands, headSha, signal } = input;
    const { limits } = deps.config.current();
    const attempt = task.counters.checkRetries + 1;
    const relativeLog = join('checks', `${attempt}-${sha7(headSha)}.log`);

    // Phase 1: tell the owner the checks are running. A Fixing task stays Fixing (no such move).
    await transact(deps, async (tx, outbox) => {
      const fresh = await loadWorkerTask(tx, input.identity);
      await deps.writer.note(tx, fresh.id, 'checks_started', 'system', {
        attempt,
        headSha,
        commands,
      });
      if (fresh.stage === 'Implementing' || fresh.stage === 'Reviewing') {
        await deps.writer.move(tx, outbox, fresh, 'Verifying', { cause: 'checks_started' });
      }
    });

    // Phase 2: the run, outside any transaction.
    let progress = Promise.resolve();
    const outcome = await deps.checkRunner
      .run({
        cwd: input.worktreePath,
        commands,
        timeoutMs: limits.checkTimeoutMinutes * 60_000,
        signal,
        logPath: join(deps.artifacts.dirFor(task.id), relativeLog),
        onProgress: (line) => {
          // Appended in order, never allowed to fail the gate.
          progress = progress
            .then(() =>
              deps.eventLog.append(input.identity.runId, {
                kind: 'system',
                payload: { subtype: 'checks_progress', message: line },
              }),
            )
            .then(
              () => undefined,
              () => undefined,
            );
        },
      })
      .catch((error: unknown) => ({
        results: [] as CheckResult[],
        unavailable: {
          command: commands[0] ?? '',
          detail: error instanceof Error ? error.message : String(error),
        },
      }));
    await progress;

    if (signal.aborted) return { refusal: runEnded() };

    // Between 2 and 3: a red command that main fails as well is not the task's.
    const reds = outcome.results.filter(isRed).map((r) => r.command);
    const base =
      outcome.unavailable === null && reds.length > 0
        ? await redOnBase(deps, {
            taskId: task.id,
            reds,
            worktreePath: input.worktreePath,
            timeoutMs: limits.checkTimeoutMinutes * 60_000,
            signal,
            relativeLog: join('checks', `${attempt}-${sha7(headSha)}-base.log`),
          })
        : { baseSha: null, preexisting: [] };
    if (signal.aborted) return { refusal: runEnded() };

    // Phase 3: write what happened.
    return transact(deps, async (tx, outbox) => {
      const fresh = await tx.tasks.get(task.id);
      if (fresh === null || !ALLOWED_STAGES.includes(fresh.stage)) {
        return { refusal: stageChanged(fresh) };
      }

      if (outcome.unavailable !== null) {
        await deps.writer.note(tx, fresh.id, 'checks_unavailable', 'system', {
          headSha,
          command: outcome.unavailable.command,
          detail: outcome.unavailable.detail,
        });
        return {
          refusal: {
            ok: false as const,
            reason: 'checks_unavailable' as const,
            detail: `\`${outcome.unavailable.command}\` could not be started: ${outcome.unavailable.detail}. This does not count against your retries; tell the owner if the command is wrong.`,
          },
        };
      }

      const results = outcome.results;
      const { baseSha, preexisting } = base;
      for (const command of preexisting) {
        await deps.writer.note(tx, fresh.id, 'check_preexisting', 'system', {
          command,
          baseSha,
          headSha,
        });
      }
      const complete = results.length === commands.length;
      if (complete && results.filter(isRed).every((r) => preexisting.includes(r.command))) {
        const passed = recordCheckPass(fresh);
        await deps.writer.update(tx, outbox, passed, 'checks_passed', 'system', {
          headSha,
          results,
          preexisting,
          baseSha,
        });
        return { results, preexisting, baseSha };
      }

      // Red. A run that ended with fewer results than commands was cut short: that is not green.
      const max = limits.checkRetries;
      const recorded = recordCheckFailure(fresh, limits);
      if (recorded.outcome === 'retry') {
        const attemptNo = recorded.task.counters.checkRetries;
        const counted = await deps.writer.update(
          tx,
          outbox,
          recorded.task,
          'checks_failed',
          'system',
          { headSha, results, attempt: attemptNo, max, preexisting },
        );
        if (counted.stage === 'Verifying') {
          await deps.writer.move(tx, outbox, counted, 'Implementing', { cause: 'checks_red' });
        }
        return {
          refusal: {
            ok: false as const,
            reason: 'checks_failed' as const,
            attempt: attemptNo,
            max,
            results,
            preexisting,
            logPath: relativeLog,
          },
        };
      }

      await deps.writer.note(tx, fresh.id, 'checks_failed', 'system', {
        headSha,
        results,
        attempt: fresh.counters.checkRetries,
        max,
      });
      const failing = results.filter(isRed).map((r) => r.command);
      const reason = `Checks still failing after ${max} retries: ${failing.join(', ') || 'a command was cut short'}`;
      const failed = await deps.writer.move(tx, outbox, fresh, 'Failed', {
        cause: 'checks_exhausted',
        reason,
      });
      const message: BodyOf<'system'> = { text: `Task ${failed.id} failed. ${reason}` };
      await deps.messages.post(tx, outbox, {
        threadId: failed.threadId,
        taskId: failed.id,
        kind: 'system',
        body: message,
      });
      outbox.stopTaskRuns(failed.id);
      return {
        refusal: {
          ok: false as const,
          reason: 'checks_exhausted' as const,
          max,
          results,
          logPath: relativeLog,
        },
      };
    });
  }

  /** After a green gate: the commit and the tree must be exactly what was checked. */
  private async settled(
    taskId: string,
    headSha: string,
  ): Promise<{ refusal: OpenPrResult | null; status: BranchStatus }> {
    const { branchPublisher } = this.deps;
    const [now, status] = await Promise.all([
      branchPublisher.headSha(taskId),
      branchPublisher.status(taskId),
    ]);
    if (now !== headSha) {
      return {
        status,
        refusal: {
          ok: false,
          reason: 'dirty_tree',
          detail: `HEAD moved from ${sha7(headSha)} to ${sha7(now)} while the checks ran. Do not commit during the call; call open_pr again.`,
        },
      };
    }
    if (status.dirtyFiles.length > 0) {
      return {
        status,
        refusal: {
          ok: false,
          reason: 'dirty_tree',
          detail:
            'Files changed while the checks ran. Commit or remove them, then call open_pr again.',
          files: [...status.dirtyFiles],
        },
      };
    }
    return { status, refusal: null };
  }

  /** Push the commit that ran, open (or find) the draft PR and move the task to `PR Open`. */
  private async publish(input: {
    readonly identity: RunIdentity;
    readonly task: Task;
    readonly repo: RepoTarget;
    readonly headSha: string;
    readonly green: GreenGate;
    readonly status: BranchStatus;
    readonly input: OpenPrInput;
  }): Promise<OpenPrResult> {
    const { deps } = this;
    const { task, repo, headSha } = input;

    const pushed = await deps.branchPublisher.push({ taskId: task.id, repo, sha: headSha });
    if (!pushed.ok) {
      await transact(deps, (tx) =>
        deps.writer.note(tx, task.id, 'push_failed', 'system', {
          headSha,
          reason: pushed.reason,
          detail: pushed.detail,
        }),
      );
      return pushed.reason === 'rejected'
        ? {
            ok: false,
            reason: 'push_rejected',
            detail: `${pushed.detail} Do not rewrite history: merge or rebase onto the remote branch, commit and call open_pr again.`,
          }
        : { ok: false, reason: 'host_error', detail: pushed.detail };
    }
    await transact(deps, (tx) =>
      deps.writer.note(tx, task.id, 'branch_pushed', 'system', { headSha, branch: task.branch }),
    );

    let number: number;
    let url: string;
    let created: boolean;
    if (task.pr !== null) {
      ({ number, url } = task.pr);
      created = false;
    } else {
      const made = await deps.codeHost.createPullRequest(
        {
          head: task.branch,
          base: deps.config.current().repo.baseBranch,
          title: input.input.title ?? '',
          body: pullRequestBody({
            body: input.input.body ?? '',
            results: input.green.results,
            preexisting: input.green.preexisting,
            baseSha: input.green.baseSha,
            headSha,
            changedFiles: input.status.changedFiles,
          }),
        },
        task.targetRepo ?? undefined,
      );
      if (!made.ok) {
        await transact(deps, (tx) =>
          deps.writer.note(tx, task.id, 'pr_create_failed', 'system', {
            headSha,
            reason: made.reason,
          }),
        );
        return {
          ok: false,
          reason: 'host_error',
          detail: `The branch is pushed, but GitHub refused the pull request: ${made.reason}. Call open_pr again; the checks will not run twice for the same commit.`,
        };
      }
      ({ number, url, created } = made);
    }

    return transact(deps, async (tx, outbox): Promise<OpenPrResult> => {
      let current = await tx.tasks.get(task.id);
      if (current === null || !ALLOWED_STAGES.includes(current.stage)) {
        return stageChanged(current, `Pull request #${number} exists: ${url}.`);
      }
      const firstPr = current.pr === null;
      if (created) await deps.writer.note(tx, task.id, 'pr_created', 'system', { number, url });
      if (firstPr) current = attachPullRequest(current, { number, url }, deps.clock.now());
      // `Implementing -> PR Open` does not exist: the gate's green passes through `Verifying`.
      if (current.stage === 'Implementing') {
        current = await deps.writer.move(tx, outbox, current, 'Verifying', {
          cause: 'checks_started',
        });
      }
      await deps.writer.move(tx, outbox, current, 'PR Open', { cause: 'pr_opened' });
      await deps.writer.note(tx, task.id, 'pr_opened', 'system', { number, url, created });

      // The watcher keeps what it already processed while the PR stays the same (CI-09).
      const watch = await tx.watches.get(task.id);
      await tx.watches.save(watch?.prNumber === number ? watch : newWatch(task.id, number));

      if (!firstPr && input.green.preexisting.length > 0) {
        const note: BodyOf<'system'> = {
          text: `Fails on main too: ${input.green.preexisting.join(', ')}`,
        };
        await deps.messages.post(tx, outbox, {
          threadId: task.threadId,
          taskId: task.id,
          kind: 'system',
          body: note,
        });
      }

      if (firstPr) {
        const body: BodyOf<'result'> = {
          taskId: task.id,
          summary: `Draft PR #${number} opened`,
          prUrl: url,
        };
        await deps.messages.post(tx, outbox, {
          threadId: task.threadId,
          taskId: task.id,
          kind: 'result',
          body,
        });
      }
      return { ok: true, number, url, headSha, created };
    });
  }
}

function runEnded(): OpenPrResult {
  return {
    ok: false,
    reason: 'checks_unavailable',
    detail: 'The run ended while the checks were running; call open_pr again.',
  };
}

function stageChanged(task: Task | null, extra = ''): OpenPrResult {
  return {
    ok: false,
    reason: 'wrong_stage',
    detail: `The task is ${task?.stage ?? 'gone'} now; open_pr no longer applies. ${extra}`.trim(),
  };
}
