import { useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { LiveStreamProvider } from './LiveStreamProvider';
import { createQueryClient } from './queryClient';
import { routes } from './routes';

export function App() {
  const [queryClient] = useState(createQueryClient);
  const [router] = useState(() => createBrowserRouter(routes));
  return (
    <QueryClientProvider client={queryClient}>
      <LiveStreamProvider>
        <RouterProvider router={router} />
      </LiveStreamProvider>
    </QueryClientProvider>
  );
}
