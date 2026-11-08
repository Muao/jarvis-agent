# web

React 19 SPA on Vite (ADR-0010): React Router, TanStack Query, CSS Modules. Types and schemas come from
`@jarvis/shared`. Root `AGENTS.md` still applies.

## Commands

- Test: `pnpm --filter @jarvis/web test` (Vitest + jsdom + RTL)
- Typecheck: `pnpm --filter @jarvis/web typecheck`
- Build: `pnpm --filter @jarvis/web build`
- E2E: `pnpm --filter @jarvis/web e2e` (Playwright, Chromium; `testDir: e2e`)
- Dev: `pnpm --filter @jarvis/web dev` (port 5180, proxies `/api` to `127.0.0.1:4310`)

## Rules

- Style with CSS Modules (`*.module.css`); no colour literals outside the token file.
- Only `src/api/**` calls `fetch` or creates an `EventSource`; components use TanStack Query hooks built on it.
- No `z.object` in `web/src`; import request/response/event types from `@jarvis/shared`.
- Status and stage are shown with text or a symbol, never colour alone.
- Manifests are frozen after T01: report a missing dependency instead of editing `package.json`.

## Tests

- RTL query priority: `getByRole` > `getByLabelText` > `getByText`; `getByTestId` last. Use `userEvent` and `findBy*`.
- Stub `fetch` / `EventSource` directly (no MSW). Colocated `*.test.ts(x)` under `src`; Playwright specs in `e2e/`.
