---
status: proposed
date: 2026-10-26
decision-makers: []  # drafted by Claude 2026-10-26 when the iteration-1 plan started; awaiting Ivan Lapa
scope: ["**/*.test.ts", "**/*.test.tsx", "**/vitest.config.ts", "web/e2e/**", "web/playwright.config.ts", "engine/test/**"]
supersedes: []
superseded-by: []
---

# ADR-0013: Test with Vitest and RTL, integration tests on a real Postgres, end to end with Playwright, and a fake `claude` binary instead of the model

## Context and Problem Statement
Most of Jarvis's risk is in orchestration: stage transitions, limits, resume after restart, the stream-json
runner, the watcher diff. These must be testable without burning the owner's Claude subscription (CON-06)
and without GitHub. Repository code must be tested against the same Postgres the engine uses (ADR-0010).

## Considered Options
- Vitest everywhere; in-memory fakes for application ports; real Postgres in Docker for `*.int.test.ts`; a scripted fake `claude` executable for runner and end-to-end tests; Playwright for the web; live `claude` only in manual smoke checks
- Mock `child_process` in unit tests only
- Run the real CLI in CI-like tests

## Decision Outcome
Chosen option: "Vitest + real Postgres + fake `claude` binary", because the fake binary exercises the real
`ClaudeCliRunner` (spawn, args, env, stream-json parsing, stdin, exit codes) and the real MCP/HTTP path at zero
model cost, while fakes keep domain and application tests fast.

- Unit: `*.test.ts(x)` next to the code. Integration: `*.int.test.ts`, serial, database `jarvis_test` on the compose Postgres.
- Fake CLI: `engine/test/fake-claude/` — reads its scenario from `JARVIS_FAKE_SCENARIO`, prints stream-json, and performs Jarvis tool calls through the engine API using the run's MCP config.
- Web: Vitest + jsdom + React Testing Library, queries by role and label; Playwright in `web/e2e/` against engine + fake CLI.
- Live `claude` runs happen only in manual smoke steps of the plan, with `--model haiku` and `--max-turns 1` unless the step says otherwise.

### Consequences
- Good, because the full flow is testable offline and for free.
- Bad, because the fake CLI can drift from the real stream-json format; a manual smoke step re-checks it against the real CLI.

### Confirmation
- RULE: No automated test spawns the real `claude` binary.
  CHECK: `grep -rn "'claude'" --include=*.test.ts engine/src` (expect only fake-binary paths) + reviewer
- RULE: Integration tests never use the `jarvis` database.
  CHECK: reviewer on `engine/test/db.ts`
