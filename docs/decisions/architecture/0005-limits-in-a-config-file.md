---
status: accepted
date: 2026-10-26
decision-makers: []  # owner asked for limits in a separate config 2026-10-26; drafted by Claude
scope: ["jarvis.config.json", "jarvis.config.example.json", "engine/src/infrastructure/config/**", "shared/src/config.ts"]
supersedes: []
superseded-by: []
---

# ADR-0005: Keep limits, models and repo settings in `jarvis.config.json`, validated with Zod at startup

## Context and Problem Statement
The owner runs Jarvis on Claude Max 5x ($100) and does not want a demo to burn the whole limit. Limits
(concurrency, retries, rounds, turns, budget, polling) must be easy to change without code edits and
must never hold secrets. A new YAML/TOML parser would be a new dependency.

## Considered Options
- `~/.jarvis/jarvis.config.json` (outside the repo, ADR-0009), `jarvis.config.example.json` committed, schema in `shared/` (Zod)
- Environment variables only
- Rows in the database edited from the UI

## Decision Outcome
Chosen option: "`jarvis.config.json` with a Zod schema", because JSON needs no new dependency, the
schema gives clear startup errors, and the file is diffable and shareable with webinar participants.

Keys and defaults for Max 5x (indicative; the engine spec fixes the final list):

| Key | Default | Covers |
|---|---|---|
| `repo.path`, `repo.remote`, `repo.baseBranch` | — | CON-04 |
| `limits.maxConcurrentWorkers` | 1 (2 allowed) | DSP-08 |
| `limits.checkRetries` | 3 | WRK-07 |
| `limits.ciFixRounds` | 2 | CI-04 |
| `limits.reviewRounds` | 3 | CI-05 |
| `limits.taskTimeoutMinutes` | 60 | WRK-11 |
| `limits.maxTurnsPerRun` | 60 | ADR-0003 |
| `limits.maxBudgetUsdPerRun` | 3 | ADR-0003 (estimate) |
| `limits.dailyBudgetUsd` | 20 | pause new runs when reached (estimate) |
| `limits.permissionTimeoutMinutes` | 30 | ADR-0004 |
| `watch.pollSeconds` | 60 | NFR-03 |
| `models.dispatcher` / `models.worker` / `models.reviewer` | `sonnet` / `sonnet` / `sonnet` | cost control |
| `allowlist.githubReviewers` | [] | CI-06 |
| `connectors.notionRoot`, `connectors.googleFolder` | — | CTX-02, CTX-03 |

The engine re-reads the file on change; a run already started keeps the values it started with.

### Consequences
- Good, because the demo can be tuned in one place and participants get a safe default.
- Bad, because dollar figures are CLI estimates, not real subscription usage; they are a brake, not a meter.

### Confirmation
- RULE: Engine startup fails with a readable error when `jarvis.config.json` does not match the schema.
  CHECK: unit test `engine/src/infrastructure/config/config.test.ts`
- RULE: The config schema has no fields for tokens or passwords.
  CHECK: reviewer on `shared/src/config.ts`
