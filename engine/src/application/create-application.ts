import { HandleCodeHostChange } from './code-host/handle-code-host-change.js';
import { PollPullRequests } from './code-host/poll-pull-requests.js';
import { ListTasks } from './conversation/list-tasks.js';
import type { Notifiers } from './transaction.js';
import { AnswerPermission } from './permissions/answer-permission.js';
import { AwaitPermission } from './permissions/await-permission.js';
import { ExpirePermission } from './permissions/expire-permission.js';
import { PermissionWaiters } from './permissions/permission-waiters.js';
import { RequestPermission } from './permissions/request-permission.js';
import { GetArtifact } from './queries/get-artifact.js';
import { GetConfig } from './queries/get-config.js';
import { GetConnections } from './queries/get-connections.js';
import { GetOverview } from './queries/get-overview.js';
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
import { LiveRuns } from './runs/live-runs.js';
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
import type { Clock } from './ports/clock.js';
import type { CodeHost } from './ports/code-host.js';
import type { ConfigProvider, ConfigStatus } from './ports/config-provider.js';
import type { ConnectionChecks } from './ports/connection-checks.js';
import type { Logger } from './ports/logger.js';
import type { IdGenerator } from './ports/id-generator.js';
import type { ProfileFiles } from './ports/profile-files.js';
import type { ProfileStore } from './ports/profile-store.js';
import type { RepoInfo } from './ports/repo-info.js';
import type { RunCoordinator } from './ports/run-coordinator.js';
import type { UnitOfWork } from './ports/unit-of-work.js';
import type { WorktreeManager } from './ports/worktree-manager.js';
import { AnswerDecision } from './tasks/answer-decision.js';
import { AnswerQuestion } from './tasks/answer-question.js';
import { AskOwner } from './tasks/ask-owner.js';
import { CancelTask } from './tasks/cancel-task.js';
import { CreateTask } from './tasks/create-task.js';
import { LogNote } from './tasks/log-note.js';
import { ReportChecks } from './tasks/report-checks.js';
import { ReportPr } from './tasks/report-pr.js';
import { ReportStage } from './tasks/report-stage.js';
import { RetryStage } from './tasks/retry-stage.js';
import { StatusCard } from './tasks/status-card.js';
import { SubmitSpec } from './tasks/submit-spec.js';
import { TaskWriter } from './tasks/task-writer.js';

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
  readonly runner: AgentRunner;
  readonly profile: ProfileStore;
  /** Read side of the Config and Connections screens. */
  readonly configStatus: ConfigStatus;
  readonly repoInfo: RepoInfo;
  readonly profileFiles: ProfileFiles;
  readonly connections: ConnectionChecks;
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
  readonly reportChecks: ReportChecks;
  readonly reportPr: ReportPr;
  readonly cancelTask: CancelTask;
  readonly retryStage: RetryStage;
  readonly scheduler: RunScheduler;
  readonly resolveRunIdentity: ResolveRunIdentity;
  readonly stopRun: StopRun;
  readonly sendToSession: SendToSession;
  readonly requestPermission: RequestPermission;
  readonly awaitPermission: AwaitPermission;
  readonly answerPermission: AnswerPermission;
  readonly expirePermission: ExpirePermission;
  readonly pollPullRequests: PollPullRequests;
  readonly detectStalls: DetectStalls;
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
}

/** Wires the use cases of conversation/, tasks/, runs/, permissions/, code-host/, supervision/ and recovery/ over the given ports. */
export function createApplication(ports: ApplicationPorts): Application {
  const { uow, ids, clock, config, worktrees, artifacts } = ports;
  const messages = new ThreadMessages({ ids, clock });
  const statusCard = new StatusCard({ messages, config });
  const writer = new TaskWriter({ clock, statusCard });

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
    runner: ports.runner,
    worktrees,
    artifacts,
    writer,
    messages,
    registry,
    liveRuns,
    eventLog,
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

  const expireOrphanedPermissions = new ExpireOrphanedPermissions({
    uow,
    liveRuns,
    expire: expirePermission,
  });
  const handler = new HandleCodeHostChange({ ...deps, config });

  const answerQuestion = new AnswerQuestion(deps);
  const answerDecision = new AnswerDecision(deps);
  return {
    postOwnerMessage: new PostOwnerMessage({ ...deps, ids, answerQuestion, answerDecision }),
    reply: new Reply(deps),
    listTasks: new ListTasks({ uow, runs: notifiers.runs }),
    sendToTask: new SendToTask(deps),
    createTask: new CreateTask({ ...deps, ids, worktrees }),
    submitSpec: new SubmitSpec({ ...deps, artifacts }),
    answerDecision,
    askOwner: new AskOwner(deps),
    answerQuestion,
    reportStage: new ReportStage(deps),
    logNote: new LogNote(deps),
    reportChecks: new ReportChecks({ ...deps, config }),
    reportPr: new ReportPr(deps),
    cancelTask: new CancelTask(deps),
    retryStage: new RetryStage(deps),
    scheduler,
    resolveRunIdentity: new ResolveRunIdentity(registry),
    stopRun: new StopRun({ ...deps, liveRuns }),
    sendToSession: new SendToSession(deps),
    requestPermission: new RequestPermission({ ...deps, ids, config, eventLog }),
    awaitPermission: new AwaitPermission({
      uow,
      clock,
      logger: ports.logger,
      waiters,
      expire: expirePermission,
    }),
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
  };
}
