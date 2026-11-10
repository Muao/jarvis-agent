import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const LOCAL_ENGINE = 'http://127.0.0.1:4310';

export default defineConfig(({ mode }) => {
  // `JARVIS_API_URL` points the `/api` proxy at a remote Jarvis instead of the local engine, e.g. the
  // server's tailnet address (`pnpm dev:remote` reads it from web/.env.remote). Only `JARVIS_`-prefixed
  // keys are loaded, and only into this config: nothing reaches the browser bundle.
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'JARVIS_');
  const target = env['JARVIS_API_URL'] || LOCAL_ENGINE;
  const remote = target !== LOCAL_ENGINE;

  // Shared by `server` (dev) and `preview` (VPS) so the two cannot drift.
  // SSE passes through: http-proxy streams the response without buffering.
  // A remote target sits behind `tailscale serve`, which routes on the Host header, so it needs it rewritten.
  const proxy = {
    '/api': { target, changeOrigin: remote },
  };

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5180,
      strictPort: true,
      proxy,
    },
    preview: {
      host: '127.0.0.1',
      port: 5180,
      allowedHosts: ['.ts.net'],
      proxy,
    },
  };
});
