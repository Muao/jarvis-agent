---
status: accepted
date: 2026-10-26
decision-makers: []  # owner: database in Docker for local work (2026-10-26); drafted by Claude
scope: ["engine/src/infrastructure/db/**", "engine/drizzle/**", "compose.yaml", "engine/src/infrastructure/artifacts/**"]
supersedes: []
superseded-by: []
---

# ADR-0008: Store Jarvis state and event journals in PostgreSQL (Docker), and SDD artifacts as files per task

## Context and Problem Statement
The first sketch kept state in `state.json` and chat context in `chats/*.md`. With a web admin that shows
live tasks, runs and console events, and with two writers (engine and watcher) inside one process, a
JSON file becomes a bottleneck and a corruption risk. SDD artifacts, on the other hand, are written by
the model and must be readable as plain Markdown by humans, the model and the PR.

## Considered Options
- PostgreSQL in Docker via Drizzle for state, journals and run events; SDD artifacts as Markdown files in a per-task folder
- Everything in `state.json` + files
- SQLite

## Decision Outcome
Chosen option: "Postgres for state, files for artifacts", because the owner asked for a local Docker
database, the Agent Ops Center stack and skills already cover Postgres + Drizzle, and artifacts stay in
the format agents and people read.

- Tables (indicative): `threads`, `messages`, `tasks`, `task_events` (append-only journal), `runs`, `run_events` (stream-json events), `permission_requests`, `watches`, `usage`.
- A state change and its journal row are written in one transaction.
- Artifacts: `<dataDir>/tasks/<task-id>/{context,spec,plan,tasks,result}.md`; the worker writes them, the engine reads and serves them. `chats/*.md` is replaced by `threads`/`messages` plus a short thread summary column the dispatcher maintains.

### Consequences
- Good, because restart of any part loses nothing (ST-04, NFR-04) and the admin queries what it needs.
- Bad, because Docker is required to run Jarvis.

### Confirmation
- RULE: Every state change writes a `task_events` row in the same transaction.
  CHECK: integration test against real Postgres
- RULE: Only `engine/src/infrastructure/db/**` imports `drizzle-orm`.
  CHECK: `grep -rn "drizzle-orm" engine/src | grep -v infrastructure/db`
