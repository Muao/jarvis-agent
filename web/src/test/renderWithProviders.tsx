import type { ReactElement, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router';
import { LiveStreamProvider } from '../app/LiveStreamProvider';
import { routes } from '../app/routes';
import { FakeEventSource } from './FakeEventSource';

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
}

interface Options {
  route?: string;
  queryClient?: QueryClient;
}

function providers(queryClient: QueryClient, children: ReactNode) {
  FakeEventSource.install();
  return (
    <QueryClientProvider client={queryClient}>
      <LiveStreamProvider>{children}</LiveStreamProvider>
    </QueryClientProvider>
  );
}

/** Renders `ui` with Query, the live stream (fake `EventSource`) and a memory router. */
export function renderWithProviders(ui: ReactElement, { route = '/', queryClient }: Options = {}) {
  const client = queryClient ?? createTestQueryClient();
  const result = render(
    providers(client, <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>),
  );
  return { ...result, queryClient: client };
}

/** Renders the whole route tree (shell included) at `route`. */
export function renderApp({ route = '/', queryClient }: Options = {}) {
  const client = queryClient ?? createTestQueryClient();
  const router = createMemoryRouter(routes, { initialEntries: [route] });
  const result = render(providers(client, <RouterProvider router={router} />));
  return { ...result, queryClient: client, router };
}
