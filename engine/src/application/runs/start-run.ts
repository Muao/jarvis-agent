import { join } from 'node:path';
import {
  assignWorkerSession,
  isTerminal,
  startRun,
  type Message,
  type Run,
  type Task,
} from '../../domain/index.js';
import type { ThreadMessages } from '../conversation/thread-messages.js';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { Clock } from '../ports/clock.js';
import type { ConfigProvider } from '../ports/config-provider.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { AgentRunner, RunSpec } from '../ports/agent-runner.js';
import type { ProfileStore } from '../ports/profile-store.js';
import type { Session } from '../ports/session-repository.js';
import type { Repositories, UnitOfWork } from '../ports/unit-of-work.js';
import type { WorktreeManager } from '../ports/worktree-manager.js';
import type { TaskWriter } from '../tasks/task-writer.js';
import { transact, type Notifiers, type Outbox } from '../transaction.js';
import type { LiveRun, LiveRuns } from './live-runs.js';
import type { RunEventLog } from './run-event-log.js';
import { untrustedContent } from '../conversation/untrusted.js';
import type { CodeHost } from '../ports/code-host.js';
import { worktreeFor } from '../tasks/worktree-for.js';
import { dispatcherFirstMessage, workerFirstMessage } from './run-prompt.js';
import type { RunRegistry } from './run-registry.js';
import { RunSink } from './run-sink.js';

export interface StartRunDeps {
  readonly uow: UnitOfWork;
  readonly notifiers: Notifiers;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly config: ConfigProvider;
  readonly profile: ProfileStore;
  readonly runner: AgentRunner;
  readonly worktrees: WorktreeManager;
  readonly artifacts: ArtifactStore;
  /** ADR-0018: read to describe the pull request a `ui_check` task is about. */
  readonly codeHost: CodeHost;
  readonly writer: TaskWriter;
  readonly messages: ThreadMessages;
  readonly registry: RunRegistry;
  readonly liveRuns: LiveRuns;
  readonly eventLog: RunEventLog;
}

/** A task waiting for the owner (or finished) has nothing for a worker to do. */
const NOT_STARTABLE = ['Spec Review', 'Blocked'];

interface Prepared {
  readonly run: Run;
  readonly session: Session;
  readonly cwd: string;
  readonly firstMessage: string;
  readonly task: Task | null;
}

/**
 * Starts one `claude` process: loads or creates the session, records the run, assembles the first
 * message, then hands a `RunSpec` to the runner. Config and USER.md are read here, so a run keeps
 * the values it started with (LIM-05) and a profile change applies from the next run (PRF-03).
 * Callers serialise calls; it never decides *whether* to start (slots, budget): the scheduler does.
 */

/** ADR-0018: what the engine can tell a `ui_check` run about its pull request, before it starts. */
interface PullRequestContext {
  /** One line for the run context. */
  readonly line: string;
  /** Which criteria sources exist, in the order the worker should try them. */
  readonly criteria: string;
  /** The PR's own text, wrapped as untrusted content; null when it carries none. */
  readonly text: string | null;
}

export class StartRun {
  constructor(private readonly deps: StartRunDeps) {}

  /** Returns false when the task needs no worker right now (finished, or waiting for the owner). */
  async worker(taskId: string, onEnded: (run: LiveRun) => Promise<void>): Promise<boolean> {
    const preferences = await this.deps.profile.userPreferences();
    // Outside the transaction on purpose: describing a pull request is a network call.
    const checked = await this.pullRequestContext(taskId);
    const prepared = await this.prepare((tx, outbox) =>
      this.prepareWorker(tx, outbox, taskId, preferences, checked),
    );
    if (prepared === null) return false;
    await this.launch(prepared, onEnded);
    return true;
  }

  /** Returns false when the thread has no queued owner message left to process. */
  async dispatcher(threadId: string, onEnded: (run: LiveRun) => Promise<void>): Promise<boolean> {
    const preferences = await this.deps.profile.userPreferences();
    const prepared = await this.prepare((tx, outbox) =>
      this.prepareDispatcher(tx, outbox, threadId, preferences),
    );
    if (prepared === null) return false;
    await this.launch(prepared, onEnded);
    return true;
  }

  private async prepare(
    work: (tx: Repositories, outbox: Outbox) => Promise<Prepared | null>,
  ): Promise<Prepared | null> {
    const prepared = await transact(this.deps, work);
    if (prepared === null) return null;
    const { events } = this.deps.notifiers;
    await events.publish({ type: 'run', id: prepared.run.id });
    await events.publish({ type: 'overview' });
    return prepared;
  }

  private async prepareWorker(
    tx: Repositories,
    outbox: Outbox,
    taskId: string,
    preferences: string | null,
    checked: PullRequestContext | null,
  ): Promise<Prepared | null> {
    const { writer, ids, clock, worktrees, artifacts, config } = this.deps;
    let task = await tx.tasks.get(taskId);
    if (task === null || isTerminal(task.stage) || NOT_STARTABLE.includes(task.stage)) return null;
    // The task's first run moves it out of Intake.
    if (task.stage === 'Intake') {
      task = await writer.move(tx, outbox, task, 'Context', { cause: 'worker_started' });
    }

    let session =
      task.workerSessionId === null ? null : await tx.sessions.get(task.workerSessionId);
    if (session === null) {
      session = {
        id: ids.sessionId(),
        role: 'worker',
        threadId: task.threadId,
        taskId: task.id,
        claudeSessionId: null,
      };
      await tx.sessions.save(session);
      task = await writer.update(
        tx,
        outbox,
        assignWorkerSession(task, session.id, clock.now()),
        'worker_session_created',
        'system',
        { sessionId: session.id },
      );
    }

    // A resumed session already has the description; a session that never got an id has not.
    const description = session.claudeSessionId === null ? await descriptionOf(tx, task.id) : null;
    const pending = await this.deliverQueued(
      tx,
      outbox,
      await tx.messages.queuedWorkerInput(task.id),
    );
    const worktree = await worktreeFor(worktrees, task);
    const run = startRun({
      id: ids.runId(),
      sessionId: session.id,
      role: 'worker',
      threadId: task.threadId,
      taskId: task.id,
      at: clock.now(),
    });
    await tx.runs.save(run);
    return {
      run,
      session,
      cwd: worktree.path,
      task,
      firstMessage: workerFirstMessage({
        taskId: task.id,
        branch: task.branch,
        artifactsDir: artifacts.dirFor(task.id),
        stage: task.stage,
        taskKind: task.kind,
        pullRequest: checked?.line ?? null,
        criteriaSources: checked?.criteria ?? null,
        pullRequestText: checked?.text ?? null,
        uiCheck: config.current().ui.enabled ? 'available' : 'disabled: ui.enabled is false',
        preferences,
        pending: pending.map(textOf),
        description,
      }),
    };
  }


  /**
   * ADR-0018: a `ui_check` run is told what its pull request is and where its criteria may come
   * from. The PR's own text is authored by whoever opened it, so it is wrapped (ADR-0017) and
   * never read as instructions. A host that cannot be reached is not fatal: the run starts with
   * `pr: unreadable` and the worker falls back to the diff.
   */
  private async pullRequestContext(taskId: string): Promise<PullRequestContext | null> {
    const { uow, artifacts, codeHost, config } = this.deps;
    const task = await uow.run((tx) => tx.tasks.get(taskId));
    if (task === null || task.kind !== 'ui_check' || task.pr === null) return null;

    const spec = await artifacts.read(task.id, 'spec.md');
    const repo = task.targetRepo ?? undefined;
    let described;
    try {
      described = await codeHost.describePullRequest(task.pr.number, repo);
    } catch (error) {
      return {
        line: `${task.pr.url} — unreadable: ${error instanceof Error ? error.message : String(error)}`,
        criteria: spec.exists ? 'spec.md, diff' : 'diff',
        text: null,
      };
    }

    const reviewers = config.current().allowlist.githubReviewers.map((r) => r.toLowerCase());
    const comments = await this.reviewerComments(task.pr.number, repo, reviewers);
    const blocks = [
      described.body.trim() === ''
        ? null
        : untrustedContent({
            source: 'pr-body',
            author: described.author,
            body: `${described.title}\n\n${described.body}`,
          }),
      ...comments,
    ].filter((b): b is string => b !== null);

    const sources = [
      ...(spec.exists ? ['spec.md'] : []),
      ...(blocks.length > 0 ? ['pr-body'] : []),
      'diff',
    ];
    return {
      line: `${task.pr.url} — ${described.state} — head ${described.headRepo.owner}/${described.headRepo.name}:${described.headRef}${described.fromFork ? ' (fork)' : ''} by ${described.author}`,
      criteria: sources.join(', '),
      text: blocks.length === 0 ? null : blocks.join('\n\n'),
    };
  }

  /** Only allow-listed reviewers' comments may suggest a scenario (ADR-0018). */
  private async reviewerComments(
    prNumber: number,
    repo: { owner: string; name: string } | undefined,
    reviewers: readonly string[],
  ): Promise<string[]> {
    if (reviewers.length === 0) return [];
    try {
      const snapshot = await this.deps.codeHost.snapshot(prNumber, repo);
      return snapshot.comments
        .filter((c) => reviewers.includes(c.author.toLowerCase()) && c.body.trim() !== '')
        .map((c) => untrustedContent({ source: 'pr-comment', author: c.author, body: c.body }));
    } catch {
      return [];
    }
  }

  private async prepareDispatcher(
    tx: Repositories,
    outbox: Outbox,
    threadId: string,
    preferences: string | null,
  ): Promise<Prepared | null> {
    const { ids, clock, config } = this.deps;
    const queued = await tx.messages.queuedDispatcherInput(threadId);
    if (queued.length === 0) return null;

    let session = await tx.sessions.dispatcherOf(threadId);
    if (session === null) {
      session = {
        id: ids.sessionId(),
        role: 'dispatcher',
        threadId,
        taskId: null,
        claudeSessionId: null,
      };
      await tx.sessions.save(session);
    }
    const delivered = await this.deliverQueued(tx, outbox, queued);
    const run = startRun({
      id: ids.runId(),
      sessionId: session.id,
      role: 'dispatcher',
      threadId,
      taskId: null,
      at: clock.now(),
    });
    await tx.runs.save(run);
    return {
      run,
      session,
      cwd: config.current().repo.path,
      task: null,
      firstMessage: dispatcherFirstMessage({ preferences, messages: delivered.map(textOf) }),
    };
  }

  /** Marks owner messages delivered; they are in this run's first message. */
  private async deliverQueued(
    tx: Repositories,
    outbox: Outbox,
    queued: readonly Message[],
  ): Promise<readonly Message[]> {
    for (const message of queued) {
      await this.deps.messages.replace(tx, outbox, {
        ...message,
        body: { ...message.body, delivery: 'delivered' },
      });
    }
    return queued;
  }

  private async launch(
    prepared: Prepared,
    onEnded: (run: LiveRun) => Promise<void>,
  ): Promise<void> {
    const { registry, liveRuns, runner, config } = this.deps;
    const { run, session } = prepared;
    const current = config.current();
    const identity = {
      runId: run.id,
      role: run.role,
      threadId: run.threadId,
      ...(run.taskId === null ? {} : { taskId: run.taskId }),
    };
    const live: LiveRun = {
      runId: run.id,
      role: run.role,
      threadId: run.threadId,
      taskId: run.taskId,
      token: registry.issue(identity),
      handle: null,
    };
    liveRuns.add(live);
    const sink = new RunSink({ ...this.deps, onEnded }, live, session.id);
    const spec: RunSpec = {
      runId: run.id,
      role: run.role,
      cwd: prepared.cwd,
      firstMessage: prepared.firstMessage,
      ...(session.claudeSessionId === null ? {} : { resumeSessionId: session.claudeSessionId }),
      model: run.role === 'worker' ? current.models.worker : current.models.dispatcher,
      maxTurns: current.limits.maxTurnsPerRun,
      maxBudgetUsd: current.limits.maxBudgetUsdPerRun,
      runToken: live.token,
      keepStdinOpen: run.role === 'worker',
      ...(run.taskId === null
        ? {}
        : {
            taskId: run.taskId,
            // ADR-0014: Playwright MCP writes unnamed screenshots straight into the task's artifacts.
            screenshotsDir: join(this.deps.artifacts.dirFor(run.taskId), 'screenshots'),
          }),
      threadId: run.threadId,
      sessionId: session.id,
    };
    this.deps.notifiers.logger.info(`run ${run.id} started`, {
      event: 'run.started',
      runId: run.id,
      sessionId: session.id,
      ...(run.taskId === null ? {} : { taskId: run.taskId }),
      threadId: run.threadId,
      role: run.role,
      model: spec.model,
    });
    try {
      live.handle = runner.start(spec, sink);
    } catch (error) {
      // Still inside the scheduler's turn, which re-checks the slots itself: no `onEnded` here.
      const failed = new RunSink(
        { ...this.deps, onEnded: async () => undefined },
        live,
        session.id,
      );
      await failed.exit({
        type: 'exit',
        code: null,
        message: `could not start claude: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}

const textOf = (message: Message): string => String(message.body.text ?? '');

/** The description the dispatcher gave when it created the task (`task_created` journal event). */
async function descriptionOf(tx: Repositories, taskId: string): Promise<string | null> {
  const events = await tx.journal.list(taskId);
  const created = events.find((e) => e.type === 'task_created');
  const description = created?.data.description;
  return typeof description === 'string' ? description : null;
}
