import type { TaskStage } from '@jarvis/shared';
import {
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
import { Outbox } from '../transaction.js';
import { StatusCard } from '../tasks/status-card.js';
import { FakeAgentRunner } from './fake-agent-runner.js';
import { FakeCodeHost } from './fake-code-host.js';
import { FakeUnitOfWork } from './fake-unit-of-work.js';
import {
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
  /** ADR-0022: what the UI check asked the engine to start. */
  readonly devServers: FakeDevServerManager;
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

  const application = createApplication({
    uow,
    ids,
    clock,
    config,
    worktrees,
    repos,
    artifacts,
    codeHost,
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
    version: '0.0.0-test',
    logger,
    ...(options.realRuns === true ? {} : { coordinator: runs }),
  });
  const statusCard = new StatusCard({ messages: new ThreadMessages({ ids, clock }), config });

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
      let current = createTask({
        id,
        threadId: thread.id,
        title: 'Seeded task',
        branch: `jarvis/${id}`,
        at: clock.now(),
        targetRepo: options.targetRepo ?? null,
      });
      for (const to of PATH_TO[stage] ?? []) {
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
