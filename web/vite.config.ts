import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Shared by `server` (dev) and `preview` (VPS) so the two cannot drift.
// SSE passes through: http-proxy streams the response without buffering.
const proxy = {
  '/api': { target: 'http://127.0.0.1:4310', changeOrigin: false },
};

export default defineConfig({
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
});
