import {
  ArtifactNameSchema,
  JarvisConfigSchema,
  type ArtifactName,
  type ConnectionId,
  type JarvisConfig,
  type StreamEvent,
} from '@jarvis/shared';
import type { IsoTime, Message } from '../../domain/index.js';
import type { ArtifactFile, ArtifactStore } from '../ports/artifact-store.js';
import type { Clock } from '../ports/clock.js';
import type { ConfigProvider, ConfigStatus } from '../ports/config-provider.js';
import type { ConnectionChecks, ConnectionOutcome } from '../ports/connection-checks.js';
import type { ProfileFile, ProfileFiles } from '../ports/profile-files.js';
import type { RepoCommands, RepoInfo } from '../ports/repo-info.js';
import type { EventBus } from '../ports/event-bus.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { LogContext, Logger } from '../ports/logger.js';
import type { ProfileStore } from '../ports/profile-store.js';
import type { OwnerChannel } from '../ports/owner-channel.js';
import type { QueuedWorkerRun, RunCoordinator, WorkerRunReason } from '../ports/run-coordinator.js';
import type { Worktree, WorktreeManager } from '../ports/worktree-manager.js';

export class FakeClock implements Clock {
  private ms: number;

  constructor(start: IsoTime = '2026-01-01T10:00:00.000Z') {
    this.ms = Date.parse(start);
  }

  now(): IsoTime {
    return new Date(this.ms).toISOString();
  }

  advanceMinutes(minutes: number): void {
    this.ms += minutes * 60_000;
  }
}

export class SequentialIds implements IdGenerator {
  private threads = 0;
  private messages = 0;
  private sessions = 0;
  private runs = 0;
  private permissions = 0;
  private tokens = 0;

  threadId(): string {
    this.threads += 1;
    return `th-${this.threads}`;
  }

  messageId(): string {
    this.messages += 1;
    return `m-${this.messages}`;
  }

  sessionId(): string {
    this.sessions += 1;
    return `s-${this.sessions}`;
  }

  runId(): string {
    this.runs += 1;
    return `r-${this.runs}`;
  }

  permissionId(): string {
    this.permissions += 1;
    return `p-${this.permissions}`;
  }

  token(): string {
    this.tokens += 1;
    return `tok-${this.tokens}`;
  }
}

export class FakeWorktreeManager implements WorktreeManager {
  readonly created: Worktree[] = [];
  private failure: Error | null = null;

  /** The next `create` rejects with `error` (and nothing is created). */
  failNext(error: Error): void {
    this.failure = error;
  }

  async create(taskId: string): Promise<Worktree> {
    if (this.failure !== null) {
      const error = this.failure;
      this.failure = null;
      throw error;
    }
    const worktree = { branch: `jarvis/${taskId}`, path: `/jarvis/worktrees/${taskId}` };
    this.created.push(worktree);
    return worktree;
  }
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly files = new Map<string, { content: string; updatedAt: IsoTime }>();

  constructor(private readonly clock: Clock = new FakeClock()) {}

  dirFor(taskId: string): string {
    return `/jarvis/tasks/${taskId}`;
  }

  /** Test helper: what the worker writes into the artifacts folder. */
  write(taskId: string, name: ArtifactName, content: string): void {
    this.files.set(`${taskId}/${name}`, { content, updatedAt: this.clock.now() });
  }

  async read(taskId: string, name: ArtifactName): Promise<ArtifactFile> {
    const file = this.files.get(`${taskId}/${name}`);
    return file === undefined
      ? { name, exists: false, content: null, updatedAt: null }
      : { name, exists: true, content: file.content, updatedAt: file.updatedAt };
  }

  async list(taskId: string): Promise<readonly Pick<ArtifactFile, 'name' | 'exists'>[]> {
    return ArtifactNameSchema.options.map((name) => ({
      name,
      exists: this.files.has(`${taskId}/${name}`),
    }));
  }
}

export class RecordingOwnerChannel implements OwnerChannel {
  readonly delivered: Message[] = [];
  readonly updates: Message[] = [];

  async deliver(message: Message): Promise<void> {
    this.delivered.push(message);
  }

  async updated(message: Message): Promise<void> {
    this.updates.push(message);
  }
}

export class RecordingEventBus implements EventBus {
  readonly published: StreamEvent[] = [];

  async publish(event: StreamEvent): Promise<void> {
    this.published.push(event);
  }
}

export type CoordinatorCall =
  | { readonly type: 'dispatcher_turn'; readonly threadId: string }
  | { readonly type: 'worker_run'; readonly taskId: string; readonly reason: WorkerRunReason }
  | { readonly type: 'deliver_to_worker'; readonly taskId: string }
  | { readonly type: 'stop_task_runs'; readonly taskId: string };

export class RecordingRunCoordinator implements RunCoordinator {
  readonly calls: CoordinatorCall[] = [];
  /** Task ids `isQueued` answers true for. */
  readonly queued = new Set<string>();
  /** What `queueSnapshot` returns; entries count as queued too. */
  readonly queue: QueuedWorkerRun[] = [];

  async requestDispatcherTurn(threadId: string): Promise<void> {
    this.calls.push({ type: 'dispatcher_turn', threadId });
  }

  async requestWorkerRun(taskId: string, reason: WorkerRunReason): Promise<void> {
    this.calls.push({ type: 'worker_run', taskId, reason });
  }

  async deliverToWorker(taskId: string): Promise<void> {
    this.calls.push({ type: 'deliver_to_worker', taskId });
  }

  async stopTaskRuns(taskId: string): Promise<void> {
    this.calls.push({ type: 'stop_task_runs', taskId });
  }

  async isQueued(taskId: string): Promise<boolean> {
    return this.queued.has(taskId) || this.queue.some((entry) => entry.taskId === taskId);
  }

  async queueSnapshot(): Promise<readonly QueuedWorkerRun[]> {
    return [...this.queue];
  }
}

export class StaticConfigProvider implements ConfigProvider {
  constructor(private config: JarvisConfig = defaultTestConfig()) {}

  current(): JarvisConfig {
    return this.config;
  }

  set(config: JarvisConfig): void {
    this.config = config;
  }
}

/** The schema defaults for everything but the required repo path. */
export function defaultTestConfig(): JarvisConfig {
  return JarvisConfigSchema.parse({ repo: { path: '/jarvis/repo' } });
}

/** USER.md in memory; tests change `text` between runs. */
export class FakeProfileStore implements ProfileStore {
  constructor(public text: string | null = null) {}

  async userPreferences(): Promise<string | null> {
    return this.text;
  }
}

/** Where the config came from; tests set `error` to simulate a rejected edit. */
export class FakeConfigStatus implements ConfigStatus {
  error: string | null = null;

  constructor(
    private readonly file: string = '/home/owner/.jarvis/jarvis.config.json',
    private readonly loaded: string | null = '2026-01-01T09:00:00.000Z',
  ) {}

  path(): string {
    return this.file;
  }

  loadedAt(): string | null {
    return this.loaded;
  }

  lastError(): string | null {
    return this.error;
  }
}

/** The target repo's commands; tests replace `found`. */
export class FakeRepoInfo implements RepoInfo {
  found: RepoCommands = {
    checkCommands: ['pnpm test', 'pnpm typecheck'],
    devCommand: 'pnpm dev',
    warning: null,
  };

  async commands(): Promise<RepoCommands> {
    return this.found;
  }
}

/** SOUL.md and USER.md in memory. */
export class FakeProfileFiles implements ProfileFiles {
  soul: ProfileFile = {
    path: '/jarvis/agent/SOUL.md',
    content: 'Be brief.',
    modifiedAt: '2026-01-01T08:00:00.000Z',
  };
  user: ProfileFile = { path: '/home/owner/.jarvis/USER.md', content: null, modifiedAt: null };

  async read(): Promise<{ soul: ProfileFile; user: ProfileFile }> {
    return { soul: this.soul, user: this.user };
  }
}

/** Connection probes with canned outcomes; unlisted connections are `not_configured`. */
export class FakeConnectionChecks implements ConnectionChecks {
  billing = false;
  readonly outcomes = new Map<ConnectionId, ConnectionOutcome>();
  readonly checked: ConnectionId[] = [];

  billingEnvDetected(): boolean {
    return this.billing;
  }

  async check(id: ConnectionId): Promise<ConnectionOutcome> {
    this.checked.push(id);
    return (
      this.outcomes.get(id) ?? { status: 'not_configured', summary: 'Not configured', details: [] }
    );
  }
}

export class RecordingLogger implements Logger {
  readonly entries: { level: 'warn' | 'error'; message: string; context: LogContext }[] = [];

  warn(message: string, context: LogContext = {}): void {
    this.entries.push({ level: 'warn', message, context });
  }

  error(message: string, context: LogContext = {}): void {
    this.entries.push({ level: 'error', message, context });
  }
}
