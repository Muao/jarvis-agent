# shared

Zod schemas and inferred TypeScript types that form the wire contract between `engine/` and `web/` (ADR-0002).

## Rules

- `shared/src/**` imports only `zod` and relative paths. No Node APIs, no DOM, no other packages.
- No runtime logic beyond schemas, derived types and tiny pure helpers.
- A change to an existing schema must be reflected in both consumers in the same task.
- Consumed as source (`exports` points to `src/index.ts`); there is no build step.
- Manifests are frozen after T01: report a missing dependency instead of editing `package.json`.

## Commands

- Test: `pnpm --filter @jarvis/shared test`
- Typecheck: `pnpm --filter @jarvis/shared typecheck`
- Lint (repo root): `pnpm lint`
