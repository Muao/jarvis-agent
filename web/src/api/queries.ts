import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  ArtifactDtoSchema,
  CapabilitiesSchema,
  ConfigDtoSchema,
  ConnectionsDtoSchema,
  OverviewDtoSchema,
  OwnerCapabilityDocSchema,
  RunEventsDtoSchema,
  SendSessionMessageResultSchema,
  SessionDtoSchema,
  TaskDetailDtoSchema,
  TaskDtoSchema,
  ThreadDetailDtoSchema,
  ThreadDtoSchema,
  UsageDtoSchema,
  UsageReportSchema,
  type AnswerMessageBody,
  type AnswerPermissionBody,
  type ArtifactName,
  type CapabilityKind,
  type OwnerAgentInput,
  type OwnerSkillInput,
  type PostMessageBody,
  type SendSessionMessageBody,
  type SetTaskModelBody,
  type TaskModel,
  type UsageQuery,
} from '@jarvis/shared';
import { del, get, post, postVoid, put, putVoid } from './client';
import { keys } from './keys';

/* Hooks are the only thing features import from `api/`. */

/* ---- reads ---- */

export const useThreads = () =>
  useQuery({
    queryKey: keys.threads.list(),
    queryFn: () => get('/threads', z.array(ThreadDtoSchema)),
  });

const ACTIVE_RUN_POLL_MS = 5_000;

export const useThread = (id: string | undefined) =>
  useQuery({
    queryKey: keys.threads.detail(id ?? ''),
    queryFn: () => get(`/threads/${encodeURIComponent(id ?? '')}`, ThreadDetailDtoSchema),
    enabled: id !== undefined,
    // A live run's latest note and tool come with the thread; poll it while one is working.
    refetchInterval: (query) => (query.state.data?.activeRun ? ACTIVE_RUN_POLL_MS : false),
  });

export const useTasks = () =>
  useQuery({
    queryKey: keys.tasks.list(),
    queryFn: () => get('/tasks', z.array(TaskDtoSchema)),
  });

export const useTask = (id: string | undefined) =>
  useQuery({
    queryKey: keys.tasks.detail(id ?? ''),
    queryFn: () => get(`/tasks/${encodeURIComponent(id ?? '')}`, TaskDetailDtoSchema),
    enabled: id !== undefined,
  });

export const useArtifact = (taskId: string, name: ArtifactName) =>
  useQuery({
    queryKey: keys.tasks.artifact(taskId, name),
    queryFn: () =>
      get(
        `/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(name)}`,
        ArtifactDtoSchema,
      ),
  });

export const useSession = (id: string | undefined) =>
  useQuery({
    queryKey: keys.sessions.detail(id ?? ''),
    queryFn: () => get(`/sessions/${encodeURIComponent(id ?? '')}`, SessionDtoSchema),
    enabled: id !== undefined,
  });

/** Events of one run. The live stream appends to this cache; it is refetched only on `run` changes. */
export const useRunEvents = (runId: string | undefined) =>
  useQuery({
    queryKey: keys.runs.events(runId ?? ''),
    queryFn: () => get(`/runs/${encodeURIComponent(runId ?? '')}/events`, RunEventsDtoSchema),
    enabled: runId !== undefined,
    select: (data) => data.events,
  });

export const useOverview = () =>
  useQuery({ queryKey: keys.overview, queryFn: () => get('/overview', OverviewDtoSchema) });

export const useConfig = () =>
  useQuery({ queryKey: keys.config, queryFn: () => get('/config', ConfigDtoSchema) });

/** `GET /api/usage`: cost over a window. Omitted `from`/`to` mean the engine's default (last 7 days). */
export const useUsageReport = (query: UsageQuery) =>
  useQuery({
    queryKey: keys.usage(query),
    queryFn: () => get('/usage', UsageReportSchema, query),
  });

export const useConnections = () =>
  useQuery({
    queryKey: keys.connections,
    queryFn: () => get('/connections', ConnectionsDtoSchema),
  });

/* ---- mutations ---- */

/** Starts a thread with its first message; the result is seeded into the detail cache. */
export function useCreateThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PostMessageBody) => post('/threads', body, ThreadDetailDtoSchema),
    onSuccess: (thread) => {
      queryClient.setQueryData(keys.threads.detail(thread.id), thread);
      return queryClient.invalidateQueries({ queryKey: keys.threads.list() });
    },
  });
}

export function usePostMessage(threadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PostMessageBody) =>
      postVoid(`/threads/${encodeURIComponent(threadId)}/messages`, body),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.threads.all }),
  });
}

/** Answers a decision or question card. */
export function useAnswerMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, body }: { messageId: string; body: AnswerMessageBody }) =>
      postVoid(`/messages/${encodeURIComponent(messageId)}/answer`, body),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.threads.all }),
  });
}

export function useAnswerPermission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ permissionId, body }: { permissionId: string; body: AnswerPermissionBody }) =>
      postVoid(`/permissions/${encodeURIComponent(permissionId)}`, body),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.threads.all }),
  });
}

function useTaskCommand(command: 'cancel' | 'retry' | 'stop' | 'hold' | 'resume') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => postVoid(`/tasks/${encodeURIComponent(taskId)}/${command}`),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.tasks.all }),
        queryClient.invalidateQueries({ queryKey: keys.threads.all }),
        queryClient.invalidateQueries({ queryKey: keys.overview }),
      ]),
  });
}

export const useCancelTask = () => useTaskCommand('cancel');
export const useRetryTask = () => useTaskCommand('retry');
export const useStopTask = () => useTaskCommand('stop');
export const useHoldTask = () => useTaskCommand('hold');
export const useResumeTask = () => useTaskCommand('resume');

/** Switches the model a task's worker runs on, from its next run. */
export function useSetTaskModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, model }: { taskId: string; model: TaskModel }) =>
      putVoid(`/tasks/${encodeURIComponent(taskId)}/model`, { model } satisfies SetTaskModelBody),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.tasks.all }),
        queryClient.invalidateQueries({ queryKey: keys.threads.all }),
      ]),
  });
}

/** Archives a thread (it leaves the list) or brings it back. */
export function useArchiveThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, archived }: { threadId: string; archived: boolean }) =>
      postVoid(`/threads/${encodeURIComponent(threadId)}/${archived ? 'archive' : 'unarchive'}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.threads.all }),
  });
}

/** "Send now": hands a message that waits for a task's worker to the thread's dispatcher. */
export function useSendNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) =>
      postVoid(`/messages/${encodeURIComponent(messageId)}/send-now`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.threads.all }),
  });
}

/** Stops one running process by run id, so dispatcher sessions can be stopped too. */
export function useStopRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => postVoid(`/runs/${encodeURIComponent(runId)}/stop`),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.sessions.all }),
        queryClient.invalidateQueries({ queryKey: keys.tasks.all }),
        queryClient.invalidateQueries({ queryKey: keys.overview }),
      ]),
  });
}

/** `POST /api/usage/reset`: spent-today counts from now on (LIM-04). */
export function useResetUsage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => post('/usage/reset', undefined, UsageDtoSchema),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.overview }),
        queryClient.invalidateQueries({ queryKey: keys.config }),
      ]),
  });
}

export function useSendSessionMessage(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SendSessionMessageBody) =>
      post(
        `/sessions/${encodeURIComponent(sessionId)}/messages`,
        body,
        SendSessionMessageResultSchema,
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.sessions.all }),
  });
}

/* ---- capabilities (ADR-0025) ---- */

/** `GET /api/capabilities`: skills, subagents and MCP servers from every source. */
export const useCapabilities = () =>
  useQuery({
    queryKey: keys.capabilities.list(),
    queryFn: () => get('/capabilities', CapabilitiesSchema),
  });

/** One of the owner's own items in full, for the editor. */
export const useOwnerCapability = (kind: CapabilityKind, name: string | undefined) =>
  useQuery({
    queryKey: keys.capabilities.owner(kind, name ?? ''),
    queryFn: () =>
      get(
        `/capabilities/owner/${kind}/${encodeURIComponent(name ?? '')}`,
        OwnerCapabilityDocSchema,
      ),
    enabled: name !== undefined,
    // The editor must show the file as it is now, not a cached copy.
    gcTime: 0,
  });

/** `PUT`: creates or replaces one of the owner's own skills or subagents. */
export function useSaveOwnerCapability(kind: CapabilityKind) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; body: OwnerSkillInput | OwnerAgentInput }) =>
      put(
        `/capabilities/owner/${kind}/${encodeURIComponent(input.name)}`,
        input.body,
        OwnerCapabilityDocSchema,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.capabilities.all }),
  });
}

export function useDeleteOwnerCapability(kind: CapabilityKind) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => del(`/capabilities/owner/${kind}/${encodeURIComponent(name)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.capabilities.all }),
  });
}

export { ApiError, NetworkError } from './client';
export { useLiveStream, useCanMutate } from './stream';
export type { ConnectionStatus, LiveStreamState } from './stream';
