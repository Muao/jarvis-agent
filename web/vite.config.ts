import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    proxy: {
      // SSE passes through: http-proxy streams the response without buffering.
      '/api': { target: 'http://127.0.0.1:4310', changeOrigin: false },
    },
  },
});
