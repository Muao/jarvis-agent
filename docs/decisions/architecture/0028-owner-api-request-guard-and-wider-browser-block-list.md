---
status: accepted
date: 2026-11-11
decision-makers: ['owner'] # security review finding H1; drafted by Claude
scope:
  [
    'engine/src/presentation/http/{owner-guard,server}.ts',
    'engine/src/infrastructure/claude/{run-files,run-context}.ts',
    'engine/src/infrastructure/config/env.ts',
    'web/src/api/client.ts',
  ]
supersedes: []
superseded-by: []
---

# ADR-0028: Mutating owner requests carry a header and a same-origin check; the worker's browser cannot reach the web UI or Postgres

Amends ADR-0014 and ADR-0026 (the Playwright origin list) and the "no login, the tailnet is the boundary" reading of ADR-0016.

## Context and Problem Statement

The owner API has no login. The UI check's browser may open any loopback port (ADR-0026: the app's
ports are chosen by the plan), and only the engine port was blocked. The web UI (`vite preview` on
127.0.0.1:5180) proxies the whole `/api`, so a prompt-injected worker could navigate there and click
Approve on its own permission cards, and the page JavaScript of the app under test could fire
body-less cross-origin POSTs (`/api/usage/reset`, cancel, hold, retry, stop, archive, send-now) at it
with `mode: 'no-cors'`, which needs no preflight.

## Decision

1. **Wider block list.** Playwright's `--blocked-origins` holds the engine port, the web UI port
   (`WEB_UI_PORT = 5180`, a constant in `run-files.ts` because the engine's config does not know it)
   and the Postgres port (taken from `DATABASE_URL`, passed as `RunContext.protectedPorts`), on
   `127.0.0.1` and `localhost`. Every other loopback port stays reachable (ADR-0026); the dev server
   refuses ports already in use, so a plan cannot pick these.
2. **Owner request guard.** A Fastify `onRequest` hook (`presentation/http/owner-guard.ts`) answers
   `403 forbidden` to any POST, PUT, PATCH or DELETE that lacks `X-Jarvis-Owner: 1`, and to any that
   carries an `Origin` whose host differs from the request's `Host` and is not listed in
   `JARVIS_ALLOWED_ORIGINS` (comma-separated, for a dev UI proxied to a remote engine, where
   `changeOrigin` rewrites `Host`). A cross-origin page cannot add the custom header without a
   preflight, and the API answers none. Reads and the SSE stream are not guarded.
3. **Exempt:** `/api/agent/*`, which authenticates with `Authorization: Bearer <run token>`.
4. The web client sends `X-Jarvis-Owner: 1` on every request. Scripts that mutate the API (for
   example a cron calling `POST /api/threads`) must send it too.

## Consequences

- A prompt-injected browser can still read the web UI if it were reachable; it no longer is, and
  what it could POST from a page is refused.
- This is a brake, not authentication: anything on the machine that can set a header still gets
  through. Real owner auth stays the tailnet boundary.
