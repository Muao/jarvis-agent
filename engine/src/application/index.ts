// What presentation and the composition root may use from the application layer.
export { createApplication } from './create-application.js';
export type { Application, ApplicationPorts } from './create-application.js';

export { ForbiddenError, InvalidInputError, NotFoundError } from './errors.js';
export type { RunIdentity } from './run-identity.js';

export type * from './ports/index.js';

export { HandleCodeHostChange } from './code-host/handle-code-host-change.js';
export { PollPullRequests } from './code-host/poll-pull-requests.js';
export { ListTasks } from './conversation/list-tasks.js';
export type { TaskList, TaskSummary } from './conversation/list-tasks.js';
export { Remember } from './profile/remember.js';
export type { RememberInput } from './profile/remember.js';
export { Forget } from './profile/forget.js';
export { MergeInsights } from './profile/merge-insights.js';
export { ReadMemory } from './profile/read-memory.js';
export { NoteInsight } from './profile/note-insight.js';
export { ConfirmInsight } from './profile/confirm-insight.js';
export { ContradictInsight } from './profile/contradict-insight.js';
export { RememberOwner } from './profile/remember-owner.js';
export { FORBIDDEN_PATHS, UpdateConfig } from './config/update-config.js';
export type { UpdateConfigInput } from './config/update-config.js';
export { PostOwnerMessage } from './conversation/post-owner-message.js';
export type { PostedOwnerMessage } from './conversation/post-owner-message.js';
export { Reply } from './conversation/reply.js';
export { SendToTask } from './conversation/send-to-task.js';

export { GetArtifact } from './queries/get-artifact.js';
export { GetConfig } from './queries/get-config.js';
export { GetConnections } from './queries/get-connections.js';
export { GetOverview } from './queries/get-overview.js';
export { GetRunEvents } from './queries/get-run-events.js';
export { GetSession } from './queries/get-session.js';
export { GetTask } from './queries/get-task.js';
export { GetTasks } from './queries/get-tasks.js';
export { GetThread } from './queries/get-thread.js';
export { GetThreads } from './queries/get-threads.js';
export { GetUsage } from './queries/get-usage.js';

export { AnswerPermission } from './permissions/answer-permission.js';
export { AwaitPermission } from './permissions/await-permission.js';
export { ExpirePermission } from './permissions/expire-permission.js';
export { RequestPermission } from './permissions/request-permission.js';
export type { PermissionRequestInput } from './permissions/request-permission.js';
export { ResumeAfterRestart } from './recovery/resume-after-restart.js';
export { DetectStalls } from './supervision/detect-stalls.js';
export { EnforceTaskTimeouts } from './supervision/enforce-task-timeouts.js';
export { ExpireOrphanedPermissions } from './supervision/expire-orphaned-permissions.js';
export { ResolveRunIdentity } from './runs/resolve-run-identity.js';
export { RunScheduler } from './runs/run-scheduler.js';
export { SendToSession } from './runs/send-to-session.js';
export type { SessionMessageDelivery } from './runs/send-to-session.js';
export { StopRun } from './runs/stop-run.js';

export { AnswerDecision } from './tasks/answer-decision.js';
export type { DecisionAnswerInput } from './tasks/answer-decision.js';
export { AnswerQuestion } from './tasks/answer-question.js';
export { AskOwner } from './tasks/ask-owner.js';
export type { AskOwnerInput } from './tasks/ask-owner.js';
export { CancelTask } from './tasks/cancel-task.js';
export type { CancelTaskInput } from './tasks/cancel-task.js';
export { CreateTask } from './tasks/create-task.js';
export type { CreatedTask, CreateTaskInput } from './tasks/create-task.js';
export { LogNote } from './tasks/log-note.js';
export { PostUpdate } from './tasks/post-update.js';
export { OpenPr } from './tasks/open-pr.js';
export type { OpenPrInput, OpenPrResult } from './tasks/open-pr.js';
export { ReportStage } from './tasks/report-stage.js';
export type { ReportStageInput } from './tasks/report-stage.js';
export { RetryStage } from './tasks/retry-stage.js';
export { SetTaskTargetRepo } from './tasks/set-task-target-repo.js';
export { HoldTask, ResumeTask, SetTaskModel } from './tasks/hold-task.js';
export { SendNow } from './conversation/send-now.js';
export type { SetTaskTargetRepoInput } from './tasks/set-task-target-repo.js';
export { SubmitSpec } from './tasks/submit-spec.js';

// Domain types that cross the application boundary (presentation may not import domain/ otherwise).
export { DomainError } from '../domain/index.js';
export type {
  DomainErrorCode,
  EventActor,
  IsoTime,
  Message,
  PermissionRequest,
  Run,
  Task,
  TaskEvent,
  Thread,
  WatchState,
} from '../domain/index.js';

export { ListCapabilities } from './capabilities/list-capabilities.js';
export {
  DeleteOwnerCapability,
  GetOwnerCapability,
  SaveOwnerCapability,
} from './capabilities/owner-capabilities.js';
