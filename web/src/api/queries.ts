import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  ArtifactDtoSchema,
  ConfigDtoSchema,
  ConnectionsDtoSchema,
  OverviewDtoSchema,
  RunEventsDtoSchema,
  SendSessionMessageResultSchema,
  SessionDtoSchema,
  TaskDetailDtoSchema,
  TaskDtoSchema,
  ThreadDetailDtoSchema,
  ThreadDtoSchema,
  type AnswerMessageBody,
  type AnswerPermissionBody,
  type ArtifactName,
  type PostMessageBody,
  type SendSessionMessageBody,
} from '@jarvis/shared';
import { get, post, postVoid } from './client';
import { keys } from './keys';

/* Hooks are the only thing features import from `api/`. */

/* ---- reads ---- */

export const useThreads = () =>
  useQuery({
    queryKey: keys.threads.list(),
    queryFn: () => get('/threads', z.array(ThreadDtoSchema)),
  });

export const useThread = (id: string | undefined) =>
  useQuery({
    queryKey: keys.threads.detail(id ?? ''),
    queryFn: () => get(`/threads/${encodeURIComponent(id ?? '')}`, ThreadDetailDtoSchema),
    enabled: id !== undefined,
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

function useTaskCommand(command: 'cancel' | 'retry' | 'stop') {
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

export { ApiError, NetworkError } from './client';
export { useLiveStream, useCanMutate } from './stream';
export type { ConnectionStatus, LiveStreamState } from './stream';
