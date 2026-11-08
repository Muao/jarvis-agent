---
status: accepted
date: 2026-10-26
decision-makers: []  # drafted by Claude 2026-10-26 when the iteration-1 plan started; awaiting Ivan Lapa
scope: ["web/**"]
supersedes: []
superseded-by: []
---

# ADR-0012: Build the web app as a React 19 + Vite SPA with react-router, CSS Modules and TanStack Query fed by SSE

## Context and Problem Statement
The web app is both the chat with Jarvis and the admin (ADR-0008, `docs/specs/web-ui-design.md`). It runs
only on the owner's laptop, talks to the engine over REST and one SSE stream, and must show run events in
under a second (NFR-08). ADR-0002 reuses the Agent Ops Center stack but leaves the web details open.
Agent messages and SDD artifacts are Markdown that may contain untrusted text (SEC-03).

## Considered Options
- React 19 + Vite SPA, react-router 7, CSS Modules over our own design tokens, TanStack Query v5 as the server cache, invalidated and patched by SSE; `react-markdown` + `remark-gfm` (tables, task lists) without raw HTML for Markdown
- Next.js
- React + Tailwind

## Decision Outcome
Chosen option: "React 19 + Vite SPA with CSS Modules and TanStack Query fed by SSE", because it is the
proven Agent Ops Center setup (ADR-0002), needs no server rendering on a local app, and Query gives
loading/error states per block for free. `react-markdown` renders Markdown as React elements and ignores raw
HTML by default, so untrusted text is never executed; `remark-gfm` adds the tables and task lists that SDD
artifacts use (added 2026-10-26 during T15, before acceptance).

- Only `web/src/api/**` calls `fetch` or `EventSource`; features use hooks from there.
- Styles: CSS Modules over `web/src/styles/tokens.css`; the owner's Claude Design output replaces the token
  values and component styles later without changing structure.
- Dev server proxies `/api` to the engine; no static hosting by the engine.

### Consequences
- Good, because the same patterns and skills as Agent Ops Center apply.
- Good, because Markdown from agents, Notion or PRs cannot inject HTML or scripts.
- Bad, because the look is provisional until the owner's design lands.

### Confirmation
- RULE: Runtime dependencies of `web/` are only `react`, `react-dom`, `react-router`, `@tanstack/react-query`, `react-markdown`, `remark-gfm`, `zod`, `@jarvis/shared`.
  CHECK: reviewer on `web/package.json`
- RULE: Only `web/src/api/**` uses `fetch(` or `EventSource`.
  CHECK: `grep -rnE "fetch\(|EventSource" web/src | grep -v "web/src/api/"` (expect none, tests excluded)
- RULE: No `rehype-raw`, `dangerouslySetInnerHTML` or Tailwind.
  CHECK: `grep -rn "dangerouslySetInnerHTML\|rehype-raw\|tailwind" web/` (expect none)
