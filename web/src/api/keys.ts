/** Query keys. Prefix-shaped so that invalidating `tasks.all` also reaches artifacts of every task. */
export const keys = {
  threads: {
    all: ['threads'] as const,
    list: () => ['threads', 'list'] as const,
    detail: (id: string) => ['threads', 'detail', id] as const,
  },
  tasks: {
    all: ['tasks'] as const,
    list: () => ['tasks', 'list'] as const,
    detail: (id: string) => ['tasks', 'detail', id] as const,
    artifact: (id: string, name: string) => ['tasks', 'detail', id, 'artifact', name] as const,
  },
  sessions: {
    all: ['sessions'] as const,
    detail: (id: string) => ['sessions', 'detail', id] as const,
  },
  runs: {
    all: ['runs'] as const,
    events: (runId: string) => ['runs', 'events', runId] as const,
  },
  overview: ['overview'] as const,
  config: ['config'] as const,
  connections: ['connections'] as const,
};
