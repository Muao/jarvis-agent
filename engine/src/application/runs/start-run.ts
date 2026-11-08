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
export class StartRun {
  constructor(private readonly deps: StartRunDeps) {}

  /** Returns false when the task needs no worker right now (finished, or waiting for the owner). */
  async worker(taskId: string, onEnded: (run: LiveRun) => Promise<void>): Promise<boolean> {
    const preferences = await this.deps.profile.userPreferences();
    const prepared = await this.prepare((tx, outbox) =>
      this.prepareWorker(tx, outbox, taskId, preferences),
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
  ): Promise<Prepared | null> {
    const { writer, ids, clock, worktrees, artifacts } = this.deps;
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
    const worktree = await worktrees.create(task.id);
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
        preferences,
        pending: pending.map(textOf),
        description,
      }),
    };
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
      ...(run.taskId === null ? {} : { taskId: run.taskId }),
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
