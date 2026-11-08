---
status: accepted
date: 2026-10-26
decision-makers: []  # drafted by Claude 2026-10-26 from the owner's brief; awaiting Ivan Lapa
scope: ["**"]
supersedes: []
superseded-by: []
---

# ADR-0002: Build Jarvis as a TypeScript pnpm monorepo with engine, web and shared modules on the Agent Ops Center stack

## Context and Problem Statement
Jarvis needs a long-running engine (orchestration, watcher, Claude CLI runs), a local web app that is
both the chat with the agent and the admin (iteration 1), and a database that runs locally in Docker.
The owner already built Agent Ops Center on a stack the team knows. The prototype must be built fast and be repeatable by webinar participants.

## Considered Options
- Reuse the Agent Ops Center stack: TypeScript pnpm monorepo, Fastify + SSE, React 19 + Vite SPA with CSS Modules and TanStack Query, PostgreSQL via Drizzle in Docker Compose, Vitest + RTL + Playwright
- Next.js full-stack app with the engine inside API routes
- A Python engine with a separate JS web app

## Decision Outcome
Chosen option: "Reuse the Agent Ops Center stack", because the stack skills kept in `.claude/skills/`
(`onion-architecture`, `fastify-best-practices`, `drizzle-orm-patterns`, `react-best-practices`, `zod`) apply as is, the engine
needs a long-lived process with child processes and timers (a poor fit for Next.js API routes), and one
language keeps contracts shared through Zod.

Modules:

| Module | Path | Purpose |
|---|---|---|
| shared | `shared/` | Zod contracts and enums shared by engine and web (`@jarvis/shared`) |
| engine | `engine/` | Fastify API + SSE, orchestration, Claude CLI runner, GitHub watcher, MCP server for agent tools, Drizzle/Postgres (`@jarvis/engine`) |
| web | `web/` | React SPA: chat + admin (`@jarvis/web`) |

Infrastructure: `compose.yaml` with PostgreSQL only. Node ≥ 22 LTS (built-in `--env-file`).

### Consequences
- Good, because the stack and its conventions are already proven in Agent Ops Center.
- Good, because the engine and web agree on shapes through one Zod contract.
- Bad, because a participant needs Node, pnpm and Docker to repeat the PoC.

### Confirmation
- RULE: Top-level packages are only `shared/`, `engine/`, `web/`; a new module needs an ADR and a row in the AGENTS.md Modules table.
  CHECK: reviewer + `cat pnpm-workspace.yaml`
- RULE: Runtime dependencies are added only when an accepted ADR names them.
  CHECK: reviewer on `**/package.json`
