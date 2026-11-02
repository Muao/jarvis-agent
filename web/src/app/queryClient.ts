import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';

/** Client errors (4xx) are final; network and 5xx failures get two more tries. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 2;
}

/** Live data is kept fresh by the SSE stream, so queries do not refetch on focus. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: shouldRetry },
    },
  });
}
