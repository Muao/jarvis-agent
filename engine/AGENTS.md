# engine

Jarvis backend: Fastify 5 + Drizzle ORM + PostgreSQL, onion layers (ADR-0003). Root `AGENTS.md` still applies.

## Layers

| Layer            | Path                              | May import                                                                                                            |
| ---------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Domain           | `src/domain/**`                   | only `domain/` plus `import type` from `@jarvis/shared`; no `fastify`, `drizzle-orm`, `zod`, `pg`, `node:`            |
| Application      | `src/application/**`              | `domain/`, `@jarvis/shared`; never `infrastructure/`, `presentation/`, `fastify`, `drizzle-orm`, `node:child_process` |
| Infrastructure   | `src/infrastructure/**`           | `domain/`, `application/` (ports), `@jarvis/shared`, `drizzle-orm`, `pg`                                              |
| Presentation     | `src/presentation/**`             | `application/`, `@jarvis/shared`, `fastify`; never `infrastructure/` or `drizzle-orm`                                 |
| Composition root | `src/container.ts`, `src/main.ts` | everything                                                                                                            |

- Child processes (`claude`, `git`, `gh`) are spawned only in `infrastructure/`.
- Concrete adapters are instantiated only in `container.ts`.
- Wire schemas live once in `shared/`; no `z.object` for request/response in `presentation/`.
- Secrets come from `~/.jarvis/.env` via `--env-file`; never read or log them elsewhere (ADR-0007).

## Commands

| Purpose           | Command                                  |
| ----------------- | ---------------------------------------- |
| Test (unit + int) | `pnpm --filter @jarvis/engine test`      |
| Unit only         | `pnpm --filter @jarvis/engine test:unit` |
| Integration only  | `pnpm --filter @jarvis/engine test:int`  |
| Typecheck         | `pnpm --filter @jarvis/engine typecheck` |

## Testing rules (ADR-0013)

- **Docker must be up for `test:int`** (`docker compose --env-file ~/.jarvis/.env up -d`, ADR-0024): `*.int.test.ts` files use Postgres on 127.0.0.1:5433,
  database `jarvis_test` (`DATABASE_URL_TEST`). Never run tests against `jarvis`.
- Unit tests: `src/**/*.test.ts` excluding `*.int.test.ts`. The `int` project runs serially (forks, `maxWorkers: 1`).
- No test runs the real `claude`; use the fake binary and fakes for ports.
- Manifests are frozen after T01: report a missing dependency instead of editing `package.json`.
