import { useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { LiveStreamContext, createLiveStream } from '../api/stream';

/** Owns the app's single SSE connection; mount once, inside `QueryClientProvider`. */
export function LiveStreamProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [stream] = useState(() => createLiveStream(queryClient));
  useEffect(() => {
    stream.start();
    return () => stream.stop();
  }, [stream]);
  return <LiveStreamContext.Provider value={stream}>{children}</LiveStreamContext.Provider>;
}
