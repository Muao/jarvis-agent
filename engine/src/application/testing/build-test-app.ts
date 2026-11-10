import type { TaskStage, TaskKind } from '@jarvis/shared';
import {
  attachPullRequest,
  createTask,
  createThread,
  transition,
  type Message,
  type Task,
  type Thread,
} from '../../domain/index.js';
import { createApplication, type Application } from '../create-application.js';
import type { RunIdentity } from '../run-identity.js';
import { ThreadMessages } from '../conversation/thread-messages.js';
import { newWatch } from '../code-host/new-watch.js';
import { Outbox, transact } from '../transaction.js';
import { loadWorkerTask } from '../tasks/guards.js';
import { StatusCard } from '../tasks/status-card.js';
import { TaskWriter } from '../tasks/task-writer.js';
import { FakeAgentRunner } from './fake-agent-runner.js';
import { FakeCapabilityCatalog, FakeOwnerPluginStore } from './fake-capabilities.js';
import { FakeCodeHost } from './fake-code-host.js';
import { FakeUnitOfWork } from './fake-unit-of-work.js';
import {
  FakeBranchPublisher,
  FakeCheckRunner,
  FakeClock,
  FakeConfigStatus,
  FakeConnectionChecks,
  FakeDatabasePing,
  FakeDevServerManager,
  FakeProfileFiles,
  FakeProfileStore,
  FakeRepoInfo,
  FakeRepoResolver,
  FakeWorktreeManager,
  InMemoryArtifactStore,
  RecordingEventBus,
  RecordingLogger,
  RecordingOwnerChannel,
  RecordingRunCoordinator,
  SequentialIds,
  StaticConfigProvider,
} from './fakes.js';
import { InMemoryDatabase } from './in-memory-database.js';

/** Stages a seeded task can start in, with the path the domain takes to reach them. */
const PATH_TO: Readonly<Partial<Record<TaskStage, readonly TaskStage[]>>> = {
  Intake: [],
  Context: ['Context'],
  'Spec Review': ['Context', 'Spec Review'],
  Implementing: ['Context', 'Spec Review', 'Implementing'],
  Verifying: ['Context', 'Spec Review', 'Implementing', 'Verifying'],
  Reviewing: ['Context', 'Spec Review', 'Implementing', 'Reviewing'],
  'PR Open': ['Context', 'Spec Review', 'Implementing', 'Verifying', 'PR Open'],
  Fixing: ['Context', 'Spec Review', 'Implementing', 'Verifying', 'PR Open', 'Fixing'],
};

/** ADR-0018: the short path a `ui_check` task takes; it has no Spec Review and no Implementing. */
const UI_CHECK_PATH_TO: Readonly<Partial<Record<TaskStage, readonly TaskStage[]>>> = {
  Intake: [],
  Context: ['Context'],
  Reviewing: ['Context', 'Reviewing'],
  Done: ['Context', 'Reviewing', 'Done'],
};

export interface SeededTask {
  readonly thread: Thread;
  readonly task: Task;
}

export interface TestApp extends Application {
  readonly db: InMemoryDatabase;
  readonly clock: FakeClock;
  readonly uow: FakeUnitOfWork;
  readonly config: StaticConfigProvider;
  readonly worktrees: FakeWorktreeManager;
  readonly repos: FakeRepoResolver;
  readonly artifacts: InMemoryArtifactStore;
  readonly codeHost: FakeCodeHost;
  /** ADR-0022: scripts what the gate's commands do, and records what it was asked to run. */
  readonly checkRunner: FakeCheckRunner;
  /** ADR-0022: scripts the worktree's state, and records what would have been pushed. */
  readonly branchPublisher: FakeBranchPublisher;
  readonly owner: RecordingOwnerChannel;
  readonly events: RecordingEventBus;
  readonly runs: RecordingRunCoordinator;
  readonly logger: RecordingLogger;
  readonly runner: FakeAgentRunner;
  readonly profile: FakeProfileStore;
  readonly configStatus: FakeConfigStatus;
  readonly repoInfo: FakeRepoInfo;
  readonly profileFiles: FakeProfileFiles;
  readonly connections: FakeConnectionChecks;
  readonly database: FakeDatabasePing;
  /** ADR-0014: what the UI check asked the engine to start. */
  readonly devServers: FakeDevServerManager;
  readonly capabilities: FakeCapabilityCatalog;
  readonly ownerPlugin: FakeOwnerPluginStore;
  /**
   * **Test shortcut**, not a use case: puts a task into `PR Open` with this PR, as `OpenPr` would,
   * without running a gate. For tests of what happens *after* a PR exists (the watcher, the
   * overview). The real path is `openPr`.
   */
  readonly reportPr: {
    execute(identity: RunIdentity, pr: { number: number; url: string }): Promise<void>;
  };
  /** Run identities as presentation would resolve them from a run token. */
  readonly identity: {
    dispatcher(threadId: string): RunIdentity;
    worker(task: Pick<Task, 'id' | 'threadId'>): RunIdentity;
  };
  readonly seed: {
    /** A thread with no task. */
    thread(title?: string): Promise<Thread>;
    /** A thread with a task in `stage` (default Context), its status card and its journal. */
    task(options?: {
      stage?: TaskStage;
      threadId?: string;
      targetRepo?: { owner: string; name: string } | null;
      /** ADR-0018: `ui_check` seeds a task that only checks `pr`, on its own short stage path. */
      kind?: TaskKind;
      pr?: { number: number; url: string };
    }): Promise<SeededTask>;
  };
  /** Forget the notifications recorded so far, so a test sees only what the use case under test sent. */
  clearEffects(): void;
  /** Current state of a task / message, read outside any use case. */
  task(id: string): Task;
  message(id: string): Message;
  messagesOf(threadId: string): Message[];
}

export interface TestAppOptions {
  /**
   * Use the real `RunScheduler` (with `runner` as its process source) instead of the recording
   * coordinator. Default false: use cases then only record what they asked `runs` to do.
   */
  readonly realRuns?: boolean;
  /** ADR-0022: `false` plays an engine with no GitHub token (`open_pr` answers `host_unconfigured`). */
  readonly hostConfigured?: boolean;
}

/** In-memory fakes for every port plus the wired use cases; reused by later tasks' tests. */
export function buildTestApp(options: TestAppOptions = {}): TestApp {
  const db = new InMemoryDatabase();
  const clock = new FakeClock();
  const ids = new SequentialIds();
  const uow = new FakeUnitOfWork(db);
  const config = new StaticConfigProvider();
  const worktrees = new FakeWorktreeManager();
  const repos = new FakeRepoResolver();
  const artifacts = new InMemoryArtifactStore(clock);
  const codeHost = new FakeCodeHost();
  const checkRunner = new FakeCheckRunner();
  const branchPublisher = new FakeBranchPublisher();
  const owner = new RecordingOwnerChannel();
  const events = new RecordingEventBus();
  const runs = new RecordingRunCoordinator();
  const logger = new RecordingLogger();
  const runner = new FakeAgentRunner();
  const profile = new FakeProfileStore();
  const configStatus = new FakeConfigStatus();
  const repoInfo = new FakeRepoInfo();
  const profileFiles = new FakeProfileFiles();
  const connections = new FakeConnectionChecks();
  const database = new FakeDatabasePing();
  const devServers = new FakeDevServerManager();
  const ownerPlugin = new FakeOwnerPluginStore();
  const capabilities = new FakeCapabilityCatalog(ownerPlugin);

  const application = createApplication({
    uow,
    ids,
    clock,
    config,
    worktrees,
    repos,
    artifacts,
    codeHost,
    checkRunner,
    branchPublisher,
    owner,
    events,
    runner,
    profile,
    configStatus,
    repoInfo,
    profileFiles,
    connections,
    database,
    devServers,
    capabilities,
    ownerPlugin,
    version: '0.0.0-test',
    logger,
    ...(options.realRuns === true ? {} : { coordinator: runs }),
    ...(options.hostConfigured === undefined ? {} : { hostConfigured: options.hostConfigured }),
  });
  const threadMessages = new ThreadMessages({ ids, clock });
  const statusCard = new StatusCard({ messages: threadMessages, config });
  const writer = new TaskWriter({ clock, statusCard, messages: threadMessages });
  const notifiers = { owner, events, runs, logger };

  const clearEffects = (): void => {
    owner.delivered.length = 0;
    owner.updates.length = 0;
    events.published.length = 0;
    runs.calls.length = 0;
  };

  const seedThread = async (title = 'Seeded thread'): Promise<Thread> => {
    const thread = createThread({ id: ids.threadId(), title, at: clock.now() });
    await uow.run((tx) => tx.threads.save(thread));
    return thread;
  };

  const seedTask: TestApp['seed']['task'] = async (options = {}) => {
    const stage = options.stage ?? 'Context';
    const thread =
      options.threadId === undefined
        ? await seedThread()
        : await uow.run(async (tx) => {
            const found = await tx.threads.get(options.threadId ?? '');
            if (found === null) throw new Error(`seed: unknown thread ${options.threadId}`);
            return found;
          });
    const task = await uow.run(async (tx) => {
      const id = await tx.tasks.nextId();
      const kind = options.kind ?? 'build';
      let current = createTask({
        id,
        threadId: thread.id,
        title: 'Seeded task',
        branch: kind === 'ui_check' ? `jarvis-check/${id}` : `jarvis/${id}`,
        at: clock.now(),
        targetRepo: options.targetRepo ?? null,
        kind,
        pr: options.pr ?? null,
      });
      const path = kind === 'ui_check' ? UI_CHECK_PATH_TO[stage] : PATH_TO[stage];
      if (path === undefined) {
        throw new Error(`seed: a ${kind} task cannot be seeded in ${stage}`);
      }
      for (const to of path) {
        const moved = transition(current, to, {
          cause: to === 'Context' ? 'worker_started' : 'stage_reported',
          at: clock.now(),
        });
        current = moved.task;
        await tx.journal.append(moved.event);
      }
      await tx.tasks.save(current);
      await statusCard.refresh(tx, new Outbox(), current);
      return current;
    });
    clearEffects();
    return { thread, task };
  };

  const must = <T>(value: T | undefined, what: string): T => {
    if (value === undefined) throw new Error(`test app: ${what} does not exist`);
    return value;
  };

  const reportPr: TestApp['reportPr'] = {
    execute: (identity, pr) =>
      transact({ uow, notifiers }, async (tx, outbox) => {
        const task = await loadWorkerTask(tx, identity);
        const firstPr = task.pr === null;
        const withPr = attachPullRequest(task, pr, clock.now());
        await writer.move(tx, outbox, withPr, 'PR Open', { cause: 'pr_opened' });
        const watch = await tx.watches.get(task.id);
        await tx.watches.save(watch?.prNumber === pr.number ? watch : newWatch(task.id, pr.number));
        if (firstPr) {
          await threadMessages.post(tx, outbox, {
            threadId: task.threadId,
            taskId: task.id,
            kind: 'result',
            body: { taskId: task.id, summary: `Draft PR #${pr.number} opened`, prUrl: pr.url },
          });
        }
      }),
  };

  return {
    ...application,
    db,
    clock,
    uow,
    config,
    worktrees,
    repos,
    artifacts,
    codeHost,
    checkRunner,
    branchPublisher,
    reportPr,
    owner,
    events,
    runs,
    logger,
    runner,
    profile,
    configStatus,
    repoInfo,
    profileFiles,
    connections,
    database,
    devServers,
    capabilities,
    ownerPlugin,
    identity: {
      dispatcher: (threadId) => ({ runId: 'run-d', role: 'dispatcher', threadId }),
      worker: (task) => ({
        runId: 'run-w',
        role: 'worker',
        threadId: task.threadId,
        taskId: task.id,
      }),
    },
    seed: { thread: seedThread, task: seedTask },
    clearEffects,
    task: (id) => must(db.tables.tasks.get(id), `task ${id}`),
    message: (id) => must(db.tables.messages.get(id), `message ${id}`),
    messagesOf: (threadId) =>
      [...db.tables.messages.values()].filter((m) => m.threadId === threadId),
  };
}
