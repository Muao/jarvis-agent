import type { StreamEvent } from '@jarvis/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ServerResponse } from 'node:http';

/** Where live notifications come from; the SSE hub in infrastructure satisfies it. */
export interface StreamSource {
  subscribe(listener: (event: StreamEvent) => void): () => void;
}

export const HEARTBEAT_MS = 15_000;

/** One unnamed `message` event whose data is a single JSON `StreamEvent`. */
export function frame(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** `GET /api/stream` (ADR-0006): live notifications, `: ping` comments as heartbeat. */
export function streamRoutes(source: StreamSource, heartbeatMs: number): FastifyPluginAsync {
  return async (http) => {
    const open = new Set<ServerResponse>();

    http.get('/stream', (request, reply) => {
      const raw = reply.raw;
      reply.hijack();
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      raw.write(': connected\n\n');
      open.add(raw);

      const write = (chunk: string): void => {
        if (!raw.destroyed && !raw.writableEnded) raw.write(chunk);
      };
      const unsubscribe = source.subscribe((event) => write(frame(event)));
      const heartbeat = setInterval(() => write(': ping\n\n'), heartbeatMs);
      raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        open.delete(raw);
      });
      request.log.debug('stream client connected');
    });

    // Without this, close() would wait for every connected browser tab.
    http.addHook('onClose', async () => {
      for (const raw of open) raw.end();
    });
  };
}
