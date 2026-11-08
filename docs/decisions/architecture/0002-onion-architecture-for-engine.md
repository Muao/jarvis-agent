---
status: accepted
date: 2026-10-26
decision-makers: []  # owner asked for onion 2026-10-26; drafted by Claude
scope: ["engine/src/**", "shared/src/**"]
supersedes: []
superseded-by: []
---

# ADR-0002: Structure the engine as an onion (Domain, Application, Infrastructure, Presentation) with Zod contracts in shared

## Context and Problem Statement
The engine holds every rule of Jarvis: the task stage machine, limits, retry and review rounds, the
one-writer rule for state, queueing. It has many drivers — HTTP from the web, Slack later, the MCP tools
that agents call, the GitHub watcher timer, Claude CLI stream events — and many adapters (Postgres,
git worktrees, Claude CLI, GitHub, file system for artifacts). Most code is written by agents, so
"where does this go" needs one checkable answer.

## Considered Options
- Onion: Domain / Application / Infrastructure / Presentation, inward-only dependencies, Zod contracts in `shared/`
- Feature folders without a layer rule
- Transaction scripts: handlers call Drizzle and child processes directly

## Decision Outcome
Chosen option: "Onion", because the stage machine and limit policy can be unit-tested without Postgres,
Claude or GitHub, and every new driver (Slack in iteration 2) is a new Presentation adapter over the same
use cases. Patterns: `.claude/skills/onion-architecture/`.

| Layer | Path | Contains | May import |
|---|---|---|---|
| Domain | `engine/src/domain/**` | `Task`, `Thread`, `Message`, `Run`, `Watch`, stage transitions, `LimitPolicy`, domain errors and events | only `domain/`, `import type` from `@jarvis/shared` |
| Application | `engine/src/application/**` | use cases (`PostOwnerMessage`, `StartTask`, `ApproveSpec`, `HandleCiChange`, `ResumeRun`, `CancelTask`, `AnswerPermission`…), ports (`TaskRepository`, `AgentRunner`, `WorktreeManager`, `CodeHost`, `ArtifactStore`, `OwnerChannel`, `Clock`, `Config`) | `domain/`, `@jarvis/shared` |
| Infrastructure | `engine/src/infrastructure/**` | Drizzle schema and repositories, `ClaudeCliRunner`, `GitWorktreeManager`, `GitHubCodeHost`, file `ArtifactStore`, config and env loaders, SSE fan-out | `domain/`, `application/` ports, `@jarvis/shared`, driver libraries |
| Presentation | `engine/src/presentation/**` | Fastify routes + SSE, MCP tool server for agents, watcher scheduler, Slack adapter (iteration 2) | `application/`, `@jarvis/shared`, `fastify`, MCP SDK |
| Composition root | `engine/src/container.ts`, `engine/src/main.ts` | wiring | everything |

### Consequences
- Good, because the riskiest logic (stages, limits, resume) is tested with in-memory fakes.
- Good, because Slack, a second engine (Codex) or another code host are adapters, not rewrites.
- Bad, because more mapping code than a transaction script.

### Confirmation
- RULE: `engine/src/domain/**` imports nothing outside `domain/` except `import type` from `@jarvis/shared`; no `fastify`, `drizzle-orm`, `zod`, `pg`, `node:` imports.
  CHECK: new architecture test `engine/src/architecture.test.ts` + `grep -rnE "from ['\"](fastify|drizzle-orm|zod|pg|node:)" engine/src/domain`
- RULE: `engine/src/application/**` does not import `infrastructure/`, `presentation/`, `fastify`, `drizzle-orm` or `node:child_process`.
  CHECK: `engine/src/architecture.test.ts`
- RULE: Child processes (`claude`, `git`, `gh`) are spawned only in `engine/src/infrastructure/**`.
  CHECK: `grep -rn "child_process" engine/src | grep -v infrastructure/`
- RULE: Concrete adapters are instantiated only in `engine/src/container.ts`.
  CHECK: reviewer
- RULE: Wire shapes (HTTP bodies, SSE events, MCP tool inputs) are Zod schemas in `shared/src/`.
  CHECK: reviewer + `grep -rn "z.object" engine/src/presentation web/src` (expect none)
