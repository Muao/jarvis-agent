import { Navigate, type RouteObject } from 'react-router';
import { Loading } from '../components/Loading';
import { NotFound } from './NotFound';
import { RouteError } from './RouteError';
import { Shell } from './Shell';

/** Every screen is a lazy route: feature code loads when first visited. */
export const routes: RouteObject[] = [
  {
    path: '/',
    Component: Shell,
    HydrateFallback: Loading,
    ErrorBoundary: RouteError,
    children: [
      { index: true, element: <Navigate to="/chat" replace /> },
      {
        path: 'chat/:threadId?',
        lazy: async () => ({ Component: (await import('../features/chat')).ChatPage }),
      },
      {
        path: 'overview',
        lazy: async () => ({ Component: (await import('../features/overview')).OverviewPage }),
      },
      {
        path: 'tasks',
        lazy: async () => ({ Component: (await import('../features/tasks')).TasksPage }),
      },
      {
        path: 'tasks/:taskId',
        lazy: async () => ({ Component: (await import('../features/tasks')).TaskDetailPage }),
      },
      {
        path: 'sessions/:sessionId',
        lazy: async () => ({ Component: (await import('../features/sessions')).SessionPage }),
      },
      {
        path: 'usage',
        lazy: async () => ({ Component: (await import('../features/usage')).UsagePage }),
      },
      {
        path: 'config',
        lazy: async () => ({ Component: (await import('../features/config')).ConfigPage }),
      },
      {
        path: 'connections',
        lazy: async () => ({
          Component: (await import('../features/connections')).ConnectionsPage,
        }),
      },
      { path: '*', Component: NotFound },
    ],
  },
];
