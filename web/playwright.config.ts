import { defineConfig, devices } from '@playwright/test';

// Real engine with a fake `claude` binary and real Postgres (ADR-0011). One worker keeps the
// single-database state deterministic; spec files run in name order and share the engine.
// The engine listens on 4310 because vite.config.ts proxies `/api` there; Playwright fails fast
// if something (e.g. `pnpm dev`) already listens on 4310 or 5180.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5180', trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @jarvis/engine exec tsx ../web/e2e/support/start-engine.ts',
      url: 'http://127.0.0.1:4310/api/overview',
      reuseExistingServer: false,
      timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    {
      command: 'pnpm --filter @jarvis/web dev',
      url: 'http://127.0.0.1:5180',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
