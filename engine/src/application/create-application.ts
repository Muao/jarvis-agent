import { HandleCodeHostChange } from './code-host/handle-code-host-change.js';
import { PollPullRequests } from './code-host/poll-pull-requests.js';
import { ListTasks } from './conversation/list-tasks.js';
import { ListCapabilities } from './capabilities/list-capabilities.js';
import {
  DeleteOwnerCapability,
  GetOwnerCapability,
  SaveOwnerCapability,
} from './capabilities/owner-capabilities.js';
import { UpdateConfig } from './config/update-config.js';
import { ConfirmInsight } from './profile/confirm-insight.js';
import { ContradictInsight } from './profile/contradict-insight.js';
import { Forget } from './profile/forget.js';
import { MemoryCap } from './profile/memory-cap.js';
import { MergeInsights } from './profile/merge-insights.js';
import { NoteInsight } from './profile/note-insight.js';
import { ReadMemory } from './profile/read-memory.js';
import { Remember } from './profile/remember.js';
import { RememberOwner } from './profile/remember-owner.js';
import type { Notifiers } from './transaction.js';
import { AnswerPermission } from './permissions/answer-permission.js';
import { AwaitPermission } from './permissions/await-permission.js';
import { ExpirePermission } from './permissions/expire-permission.js';
import { PermissionWaiters } from './permissions/permission-waiters.js';
import { RequestPermission } from './permissions/request-permission.js';
import { GetArtifact } from './queries/get-artifact.js';
import { GetConfig } from './queries/get-config.js';
import { GetConnections } from './queries/get-connections.js';
import { GetHealth } from './queries/get-health.js';
import { GetOverview } from './queries/get-overview.js';
import { GetUsage } from './queries/get-usage.js';
import { GetRunEvents } from './queries/get-run-events.js';
import { GetSession } from './queries/get-session.js';
import { GetTask } from './queries/get-task.js';
import { GetTasks } from './queries/get-tasks.js';
import { GetThread } from './queries/get-thread.js';
import { GetThreads } from './queries/get-threads.js';
import { ResumeAfterRestart } from './recovery/resume-after-restart.js';
import { DetectStalls } from './supervision/detect-stalls.js';
import { EnforceTaskTimeouts } from './supervision/enforce-task-timeouts.js';
import { ExpireOrphanedPermissions } from './supervision/expire-orphaned-permissions.js';
import { PostProgressUpdates } from './supervision/post-progress-updates.js';
import { LiveRuns } from './runs/live-runs.js';
import { ResetDailyUsage } from './runs/reset-daily-usage.js';
import { ResolveRunIdentity } from './runs/resolve-run-identity.js';
import { RunEventLog } from './runs/run-event-log.js';
import { RunRegistry } from './runs/run-registry.js';
import { RunScheduler } from './runs/run-scheduler.js';
import { SendToSession } from './runs/send-to-session.js';
import { StopRun } from './runs/stop-run.js';
import { PostOwnerMessage } from './conversation/post-owner-message.js';
import { Reply } from './conversation/reply.js';
import { SendToTask } from './conversation/send-to-task.js';
import { ThreadMessages } from './conversation/thread-messages.js';
import type { AgentRunner } from './ports/agent-runner.js';
import type { ArtifactStore } from './ports/artifact-store.js';
import type { BranchPublisher } from './ports/branch-publisher.js';
import type { CapabilityCatalog, OwnerPluginStore } from './ports/capabilities.js';
import type { CheckRunner } from './ports/check-runner.js';
import type { Clock } from './ports/clock.js';
import type { CodeHost } from './ports/code-host.js';
import type { ConfigProvider, ConfigStatus } from './ports/config-provider.js';
import type { ConnectionChecks } from './ports/connection-checks.js';
import type { DatabasePing } from './ports/database-ping.js';
import type { DevServerManager } from './ports/dev-server.js';
import type { Logger } from './ports/logger.js';
import type { IdGenerator } from './ports/id-generator.js';
import type { ProfileFiles } from './ports/profile-files.js';
import type { ProfileStore } from './ports/profile-store.js';
import type { RepoInfo } from './ports/repo-info.js';
import type { RepoResolver } from './ports/repo-resolver.js';
import type { RunCoordinator } from './ports/run-coordinator.js';
import type { UnitOfWork } from './ports/unit-of-work.js';
import type { WorktreeManager } from './ports/worktree-manager.js';
import { AnswerDecision } from './tasks/answer-decision.js';
import { AnswerQuestion } from './tasks/answer-question.js';
import { AskOwner } from './tasks/ask-owner.js';
import { CancelTask } from './tasks/cancel-task.js';
import { CreateTask } from './tasks/create-task.js';
import { LogNote } from './tasks/log-note.js';
import { PostUpdate } from './tasks/post-update.js';
import { OpenPr } from './tasks/open-pr.js';
import { ReportStage } from './tasks/report-stage.js';
import { RetryStage } from './tasks/retry-stage.js';
import { SetTaskTargetRepo } from './tasks/set-task-target-repo.js';
import { HoldTask, ResumeTask, SetTaskModel } from './tasks/hold-task.js';
import { SendNow } from './conversation/send-now.js';
import { StatusCard } from './tasks/status-card.js';
import { SubmitSpec } from './tasks/submit-spec.js';
import { TaskWriter } from './tasks/task-writer.js';
import { AttachImage } from './ui/attach-image.js';
import { CommentOnPr } from './ui/comment-on-pr.js';
import { TrustPullRequestHead } from './ui/trust-pull-request-head.js';
import { StartDevServer } from './ui/start-dev-server.js';
import { StopDevServer } from './ui/stop-dev-server.js';

/** Every port the use cases need; the composition root (or `buildTestApp`) supplies the adapters. */
export interface ApplicationPorts extends Omit<Notifiers, 'runs'> {
  readonly uow: UnitOfWork;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly config: ConfigProvider;
  readonly worktrees: WorktreeManager;
  readonly artifacts: ArtifactStore;
  readonly codeHost: CodeHost;
  /** ADR-0022: runs the owner-approved check commands in a task's worktree. */
  readonly checkRunner: CheckRunner;
  /** ADR-0022: the engine's own git; pushes a task's branch. */
  readonly branchPublisher: BranchPublisher;
  /**
   * ADR-0022: false when the engine has no GitHub token, so `open_pr` answers `host_unconfigured`
   * before it runs anything. Left out (true) in tests.
   */
  readonly hostConfigured?: boolean;
  readonly runner: AgentRunner;
  readonly profile: ProfileStore;
  /** Read side of the Config and Connections screens. */
  readonly configStatus: ConfigStatus;
  readonly repoInfo: RepoInfo;
  /** ADR-0012: checks a task's requested target repo against the allow-list / owner-account rule. */
  readonly repos: RepoResolver;
  readonly profileFiles: ProfileFiles;
  readonly connections: ConnectionChecks;
  /** Is the database reachable (`GET /api/health`). */
  readonly database: DatabasePing;
  /** ADR-0014: the engine-owned dev server the worker's UI check runs against. */
  readonly devServers: DevServerManager;
  /** ADR-0025: skills, subagents and MCP servers a run can use (read side). */
  readonly capabilities: CapabilityCatalog;
  /** ADR-0025: the owner's own plugin. Used by the HTTP use cases only, never by an agent tool. */
  readonly ownerPlugin: OwnerPluginStore;
  /** The engine's version, read once at start-up. */
  readonly version: string;
  /**
   * What the task and conversation use cases ask for runs. The `RunScheduler` by default; tests
   * that only check what was asked pass a recording one so no process is involved.
   */
  readonly coordinator?: RunCoordinator;
}

export interface Application {
  readonly postOwnerMessage: PostOwnerMessage;
  readonly reply: Reply;
  readonly listTasks: ListTasks;
  readonly sendToTask: SendToTask;
  readonly createTask: CreateTask;
  readonly submitSpec: SubmitSpec;
  readonly answerDecision: AnswerDecision;
  readonly askOwner: AskOwner;
  readonly answerQuestion: AnswerQuestion;
  readonly reportStage: ReportStage;
  readonly logNote: LogNote;
  readonly postUpdate: PostUpdate;
  /** ADR-0022: the engine runs the checks, pushes the branch and opens the draft PR. */
  readonly openPr: OpenPr;
  readonly cancelTask: CancelTask;
  readonly retryStage: RetryStage;
  readonly setTaskTargetRepo: SetTaskTargetRepo;
  readonly holdTask: HoldTask;
  readonly resumeTask: ResumeTask;
  readonly setTaskModel: SetTaskModel;
  readonly sendNow: SendNow;
  readonly remember: Remember;
  /** ADR-0021: the rest of the memory tools. */
  readonly forget: Forget;
  readonly mergeInsights: MergeInsights;
  readonly readMemory: ReadMemory;
  readonly noteInsight: NoteInsight;
  readonly confirmInsight: ConfirmInsight;
  readonly contradictInsight: ContradictInsight;
  readonly rememberOwner: RememberOwner;
  readonly updateConfig: UpdateConfig;
  /** ADR-0014: the worker's UI check. */
  readonly startDevServer: StartDevServer;
  readonly stopDevServer: StopDevServer;
  readonly attachImage: AttachImage;
  readonly commentOnPr: CommentOnPr;
  readonly scheduler: RunScheduler;
  readonly resetDailyUsage: ResetDailyUsage;
  readonly resolveRunIdentity: ResolveRunIdentity;
  readonly stopRun: StopRun;
  readonly sendToSession: SendToSession;
  readonly requestPermission: RequestPermission;
  readonly awaitPermission: AwaitPermission;
  readonly answerPermission: AnswerPermission;
  readonly expirePermission: ExpirePermission;
  readonly pollPullRequests: PollPullRequests;
  readonly detectStalls: DetectStalls;
  readonly postProgressUpdates: PostProgressUpdates;
  readonly enforceTaskTimeouts: EnforceTaskTimeouts;
  readonly expireOrphanedPermissions: ExpireOrphanedPermissions;
  readonly resumeAfterRestart: ResumeAfterRestart;
  /** Read side: one query per screen of the web UI (ADM-01…ADM-08). */
  readonly getThreads: GetThreads;
  readonly getThread: GetThread;
  readonly getTasks: GetTasks;
  readonly getTask: GetTask;
  readonly getArtifact: GetArtifact;
  readonly getSession: GetSession;
  readonly getRunEvents: GetRunEvents;
  readonly getOverview: GetOverview;
  readonly getConfig: GetConfig;
  readonly getConnections: GetConnections;
  readonly getHealth: GetHealth;
  readonly getUsage: GetUsage;
  /** ADR-0025: the Capabilities page and the owner's own skills and subagents. */
  readonly listCapabilities: ListCapabilities;
  readonly getOwnerCapability: GetOwnerCapability;
  readonly saveOwnerCapability: SaveOwnerCapability;
  readonly deleteOwnerCapability: DeleteOwnerCapability;
}

/** Wires the use cases of conversation/, tasks/, runs/, permissions/, code-host/, supervision/ and recovery/ over the given ports. */
export function createApplication(ports: ApplicationPorts): Application {
  const { uow, ids, clock, config, worktrees, artifacts } = ports;
  const startedAt = clock.now();
  const messages = new ThreadMessages({ ids, clock });
  const statusCard = new StatusCard({ messages, config });
  const writer = new TaskWriter({
    clock,
    statusCard,
    messages,
    memoryOverCap: (task) =>
      new MemoryCap({ profile: ports.profile, repos: ports.repos, config }).overCap(task),
  });

  const registry = new RunRegistry(ids);
  const liveRuns = new LiveRuns();
  const eventLog = new RunEventLog({ uow, events: ports.events, clock });
  const scheduler = new RunScheduler({
    uow,
    notifiers: { owner: ports.owner, events: ports.events, logger: ports.logger },
    clock,
    ids,
    config,
    profile: ports.profile,
    repos: ports.repos,
    runner: ports.runner,
    worktrees,
    artifacts,
    codeHost: ports.codeHost,
    writer,
    messages,
    registry,
    liveRuns,
    eventLog,
    connections: ports.connections,
    devServers: ports.devServers,
  });
  const notifiers: Notifiers = {
    owner: ports.owner,
    events: ports.events,
    runs: ports.coordinator ?? scheduler,
    logger: ports.logger,
  };
  const deps = { uow, notifiers, clock, writer, messages };
  const waiters = new PermissionWaiters();
  const expirePermission = new ExpirePermission({ ...deps, waiters, eventLog });
  const requestPermission = new RequestPermission({ ...deps, ids, config, eventLog });
  const awaitPermission = new AwaitPermission({
    uow,
    clock,
    logger: ports.logger,
    waiters,
    expire: expirePermission,
  });
  // ADR-0018: the gate in front of running a pull request's own code; it can wait on the owner.
  const trustHead = new TrustPullRequestHead({
    ...deps,
    config,
    codeHost: ports.codeHost,
    permissions: { request: requestPermission, await: awaitPermission },
  });

  const expireOrphanedPermissions = new ExpireOrphanedPermissions({
    uow,
    liveRuns,
    expire: expirePermission,
  });
  const handler = new HandleCodeHostChange({ ...deps, config });

  const capabilityDeps = { catalog: ports.capabilities, store: ports.ownerPlugin };
  const answerQuestion = new AnswerQuestion(deps);
  const answerDecision = new AnswerDecision(deps);
  return {
    postOwnerMessage: new PostOwnerMessage({ ...deps, ids, answerQuestion, answerDecision }),
    reply: new Reply(deps),
    listTasks: new ListTasks({ uow, runs: notifiers.runs }),
    sendToTask: new SendToTask(deps),
    createTask: new CreateTask({ ...deps, ids, worktrees, repos: ports.repos }),
    submitSpec: new SubmitSpec({ ...deps, artifacts, repoInfo: ports.repoInfo, worktrees }),
    answerDecision,
    askOwner: new AskOwner(deps),
    answerQuestion,
    reportStage: new ReportStage(deps),
    logNote: new LogNote(deps),
    postUpdate: new PostUpdate(deps),
    openPr: new OpenPr({
      ...deps,
      config,
      repoInfo: ports.repoInfo,
      worktrees,
      checkRunner: ports.checkRunner,
      branchPublisher: ports.branchPublisher,
      codeHost: ports.codeHost,
      artifacts,
      repos: ports.repos,
      eventLog,
      liveRuns,
      ...(ports.hostConfigured === undefined ? {} : { hostConfigured: ports.hostConfigured }),
    }),
    cancelTask: new CancelTask(deps),
    retryStage: new RetryStage(deps),
    setTaskTargetRepo: new SetTaskTargetRepo({ ...deps, repos: ports.repos }),
    holdTask: new HoldTask(deps),
    resumeTask: new ResumeTask(deps),
    setTaskModel: new SetTaskModel(deps),
    sendNow: new SendNow(deps),
    remember: new Remember({ profile: ports.profile, clock }),
    forget: new Forget({ profile: ports.profile, logger: ports.logger }),
    mergeInsights: new MergeInsights({ profile: ports.profile, logger: ports.logger }),
    readMemory: new ReadMemory({ profile: ports.profile }),
    noteInsight: new NoteInsight({
      ...deps,
      profile: ports.profile,
      repos: ports.repos,
      worktrees,
    }),
    confirmInsight: new ConfirmInsight({ ...deps, profile: ports.profile }),
    contradictInsight: new ContradictInsight({ ...deps, profile: ports.profile }),
    rememberOwner: new RememberOwner({ ...deps, profile: ports.profile, repos: ports.repos }),
    updateConfig: new UpdateConfig({ ...deps, config }),
    startDevServer: new StartDevServer({
      ...deps,
      devServers: ports.devServers,
      worktrees,
      trustHead,
    }),
    stopDevServer: new StopDevServer({ ...deps, devServers: ports.devServers }),
    attachImage: new AttachImage({ ...deps, config, artifacts, codeHost: ports.codeHost }),
    commentOnPr: new CommentOnPr({
      ...deps,
      config,
      codeHost: ports.codeHost,
      permissions: { request: requestPermission, await: awaitPermission },
    }),
    scheduler,
    resetDailyUsage: new ResetDailyUsage({ uow, clock, config, events: ports.events, scheduler }),
    resolveRunIdentity: new ResolveRunIdentity(registry),
    stopRun: new StopRun({ ...deps, liveRuns }),
    sendToSession: new SendToSession(deps),
    requestPermission,
    awaitPermission,
    answerPermission: new AnswerPermission({ ...deps, waiters, eventLog }),
    expirePermission,
    pollPullRequests: new PollPullRequests({
      uow,
      notifiers,
      clock,
      config,
      codeHost: ports.codeHost,
      handler,
      messages,
    }),
    detectStalls: new DetectStalls({ ...deps, config }),
    postProgressUpdates: new PostProgressUpdates({ ...deps, config }),
    enforceTaskTimeouts: new EnforceTaskTimeouts({ ...deps, config, artifacts }),
    expireOrphanedPermissions,
    resumeAfterRestart: new ResumeAfterRestart({
      ...deps,
      liveRuns,
      orphanedPermissions: expireOrphanedPermissions,
    }),
    getThreads: new GetThreads({ uow }),
    getThread: new GetThread({ uow }),
    getTasks: new GetTasks({ uow, runs: notifiers.runs }),
    getTask: new GetTask({ uow, runs: notifiers.runs, config, artifacts }),
    getArtifact: new GetArtifact({ uow, artifacts }),
    getSession: new GetSession({ uow, config, clock }),
    getRunEvents: new GetRunEvents({ uow }),
    getOverview: new GetOverview({ uow, runs: notifiers.runs, config, clock }),
    getConfig: new GetConfig({
      uow,
      clock,
      config,
      status: ports.configStatus,
      repoInfo: ports.repoInfo,
      profile: ports.profileFiles,
    }),
    getConnections: new GetConnections({ checks: ports.connections, clock }),
    getUsage: new GetUsage({ uow, clock }),
    listCapabilities: new ListCapabilities({ catalog: ports.capabilities }),
    getOwnerCapability: new GetOwnerCapability(capabilityDeps),
    saveOwnerCapability: new SaveOwnerCapability(capabilityDeps),
    deleteOwnerCapability: new DeleteOwnerCapability(capabilityDeps),
    getHealth: new GetHealth({
      database: ports.database,
      checks: ports.connections,
      uow,
      clock,
      startedAt,
      version: ports.version,
    }),
  };
}
