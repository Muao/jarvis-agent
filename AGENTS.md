# AGENTS.md

Instructions for AI coding agents working in this repository. Claude Code reads it natively — do not add
a `CLAUDE.md`.

## Project

**Jarvis** — a personal AI development agent that runs on the owner's laptop through the Claude Code
subscription: task in chat → context → spec → plan → code → checks → review → draft PR → CI and review
follow-up. What it does: `docs/specs/abstract-project-spec.md`. How it is built:
`docs/architecture/README.md` and `docs/decisions/architecture/`. Do not add dependencies or frameworks
that no ADR allows; propose an ADR first.

## Repository layout

```
AGENTS.md                    agent instructions (this file)
STATUS.md                    current state, what is done, what is next — read it first, keep it updated
.claude/agents/              implementer, spec-creator
.claude/skills/              stack skills: onion-architecture, fastify, drizzle, react, zod
docs/specs/                  what and why: abstract spec, UI design brief, feature specs
docs/architecture/           how it is built (README + overview.html)
docs/decisions/architecture/ ADRs — technical decisions that constrain the code
docs/webinar/                webinar concept the prototype is built for
<module>/                    each package/app, once created (see Modules)
```

## Modules

Add a row when a module is created.

| Module | Path      | Purpose                                                              | Test command                        | Typecheck command                        |
| ------ | --------- | -------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------- |
| shared | `shared/` | Zod contracts shared by engine and web                               | `pnpm --filter @jarvis/shared test` | `pnpm --filter @jarvis/shared typecheck` |
| engine | `engine/` | Fastify API, Drizzle/Postgres, runs `claude` (int tests need Docker) | `pnpm --filter @jarvis/engine test` | `pnpm --filter @jarvis/engine typecheck` |
| web    | `web/`    | React SPA (e2e: `pnpm --filter @jarvis/web e2e`)                     | `pnpm --filter @jarvis/web test`    | `pnpm --filter @jarvis/web typecheck`    |

## Rules

- Never set `ANTHROPIC_API_KEY` or call the Anthropic API/SDK: Jarvis runs Claude only through the `claude` CLI on the subscription (ADR-0004).
- Secrets live only in `~/.jarvis/.env`; limits and settings in `~/.jarvis/jarvis.config.json`. Commit only the `*.example` files.
- Keep diffs in scope: no drive-by refactors, renames or "improvements" outside the task.
- Conventional commits. Branch from `main`.
- Reply to the user in the language they wrote in; code and identifiers stay in English. Specs may be in Ukrainian.
