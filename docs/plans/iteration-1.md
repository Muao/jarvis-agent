# Implementation Plan: Jarvis iteration 1 (engine + Postgres + web chat/admin)

Product: `docs/specs/abstract-project-spec.md` (IDs `SLK-*`, `DSP-*`, `WRK-*`, `CTX-*`, `CI-*`, `ST-*`, `PRF-*`,
`LIM-*`, `SEC-*`, `ADM-*`, `NFR-*`). UI: `docs/specs/web-ui-design.md`. Architecture: `docs/architecture/README.md`.
Decisions: ADR-0002…0013 (all `proposed`; this plan treats them as binding — the owner accepts or supersedes them).

## How this plan is executed

- One `implementer` agent (model `sonnet`, `.claude/agents/implementer.md`) per task. Tasks in the same batch
  run in parallel only when their **Owned paths** do not overlap.
- After every phase the orchestrator (main session) runs a **gate**: install, typecheck, lint, tests, the ADR
  Confirmation greps for the touched scope, a read of the diff for design quality, and the phase's live smoke.
  A red gate goes back to an implementer as a fix task; the next phase starts only on green.
- Agents write files with absolute paths under `/Users/ilapa/projects/jarvis`; throwaway probes go to the
  session scratchpad, never under `src/`. Manifests (`package.json`) change only in the task that owns them.
- No automated test runs the real `claude` (ADR-0013). Live checks in gates use `--model haiku` and minimal turns.

## Quality bar ("elegant")

- Small modules with one job; names from the glossary (`Thread`, `Task`, `Run`, `Worktree`…); no `utils.ts` dumps.
- Domain is pure functions + plain data; every rule (transitions, limits, watcher diff) lives in exactly one place.
- Errors are typed (`DomainError` with a `code`), mapped to HTTP once in presentation.
- No `any`, no non-null assertions to silence types, no commented-out code, no speculative options.
- Each use case: one file, one exported function/class, dependencies by constructor, tested with fakes.

## Execution environment

| Thing | Value |
|---|---|
| Node / pnpm | Node 22 (local 22.17), pnpm 10.23.0 pinned in `packageManager` |
| Versions | Same as Agent Ops Center: TypeScript 6.0.3, Fastify 5.12.7, Drizzle 0.45.4 / drizzle-kit 0.31.11, pg 8.23.1, Zod 4.6.7, Vitest 5.0.5, tsx 4.23.15, React 19.3.1, react-router 7.18.4, TanStack Query 5.104.5, Vite 8.3.5, Playwright 1.64.1; plus `@modelcontextprotocol/sdk` 1.32.2, `@octokit/rest` 22.0.1, `react-markdown` 10.1.0, `remark-gfm` 4.0.1 |
| Postgres | `postgres:18-alpine`, host port **5433** (5432 is taken by Agent Ops Center); DBs `jarvis`, `jarvis_test` |
| Engine | `127.0.0.1:4310`; web dev server `127.0.0.1:5180` proxying `/api` |
| Jarvis Home | `JARVIS_HOME` env, default `~/.jarvis` (ADR-0011) |

## Design core (shared by all tasks)

### Task stages (domain, ADR-0003)

`Intake → Context → Spec Review → Implementing → Verifying → Reviewing → PR Open ⇄ Fixing → Done`, plus
`Blocked`, `Failed`, `Cancelled`.

| From | To | Trigger |
|---|---|---|
| Intake | Context | worker run starts |
| Context | Spec Review | worker `submit_spec_for_approval` |
| Spec Review | Context | owner `Request changes` (WRK-04) |
| Spec Review | Implementing | owner `Approve` |
| Implementing / Verifying / Reviewing | Implementing / Verifying / Reviewing | worker `report_stage` |
| Reviewing (or Verifying) | PR Open | worker `report_pr` (CI-01) |
| PR Open | Fixing | watcher: CI failed (rounds left) or allowed review comment (CI-04, CI-05) |
| Fixing | PR Open | worker `report_pr` after push |
| PR Open | Done | CI green + approved, or owner "done" (CI-08) |
| any active | Blocked | `ask_owner` (WRK-05), source unavailable (CTX-05), rounds exhausted (CI-04) |
| Blocked | `resumeStage` | owner answer |
| any active | Failed | check retries / task timeout exhausted (WRK-11) |
| any non-terminal | Cancelled | owner cancel (DSP-06) |

`waitingFor` is derived, never stored ad hoc: `owner` (Spec Review, Blocked with a question, pending permission),
`ci` / `review` (PR Open), `worker slot` (queued), `—` otherwise.

### Routing rules

- An owner message in a thread **without** an active task → a dispatcher turn (one at a time per thread; later
  messages are `queued`). In a thread **with** an active task → worker input (DSP-04): written to the live
  worker's stdin, otherwise stored and delivered as the next run's prompt.
- Decision, question and permission cards are answered through dedicated endpoints, not free text (SLK-06 text
  answers are routed as worker input).
- Dispatcher runs do not take worker slots; every run checks the daily budget (LIM-04).

### Runs and sessions

- `Session` = one Claude CLI session: dispatcher session per thread, worker session per task (`claude_session_id`
  stored, `--resume` on every later run). `Run` = one `claude` process.
- Run argv is built by one pure function (ADR-0004/0011): `-p --output-format stream-json --verbose`,
  `--input-format stream-json` for workers, `--resume <id>` when known, `--model`, `--max-turns`,
  `--max-budget-usd`, `--plugin-dir <repo>/agent`, `--setting-sources project,local`,
  `--mcp-config <runDir>/mcp.json --strict-mcp-config`, `--permission-prompt-tool mcp__jarvis__approve`,
  `--settings <runDir>/settings.json`, `--append-system-prompt-file agent/prompts/<role>.md`.
- `USER.md` is prepended to each run's **first user message** (not the system prompt): the CLI records the system
  prompt at a session's first request and reuses it on resume, so this is what makes PRF-03 work.
- Child env is an allow-list (`PATH`, `HOME`, `LANG`, `TERM`, `GH_TOKEN` for workers, `JARVIS_*` for the MCP
  server); `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/cloud switches are never passed and block startup (SEC-05).
- Each run gets a random **run token**. The MCP server sends it as `Authorization: Bearer`; the engine maps it to
  `{ runId, role, taskId?, threadId }`. No tool takes identity as an argument (ADR-0005).
- stream-json lines are normalised into `RunEvent { seq, runId, kind: 'text'|'tool_use'|'tool_result'|'permission'|'system'|'result'|'error', parentToolUseId?, payload, at }`,
  stored in `run_events` and pushed over SSE. Subagent events keep `parentToolUseId` (nested in the console).

### Ports (application)

`UnitOfWork` (transaction over the repositories below; every task state change appends a `task_events` row in the
same transaction — ADR-0010), `ThreadRepository`, `TaskRepository`, `RunRepository`, `PermissionRepository`,
`WatchRepository`, `AgentRunner` (start, write input, stop; emits events/exit), `WorktreeManager`,
`ArtifactStore`, `CodeHost` (PR snapshot), `OwnerChannel` (post/update thread messages — ADR-0008),
`EventBus` (live notifications), `ConfigProvider` (current validated config), `Clock`, `IdGenerator`.

### Data (ADR-0010)

`threads`, `messages` (kind: `owner|jarvis|status|decision|question|permission|result|system`, body jsonb,
`answer` jsonb + `answered_at` for cards — one answer only), `tasks` (`T-<n>` ids, stage, resume_stage, branch,
pr_number/url, counters `check_retries|ci_fix_rounds|review_rounds`, worker_session_id, started_at), `task_events`
(append-only), `sessions`, `runs` (status `running|completed|failed|stopped|limit_reached|interrupted`, usage
tokens, `cost_usd`, turns, exit code, error), `run_events`, `permission_requests`, `watches`. Usage today = sum of
`runs.cost_usd` since local midnight (no separate table).

### Wire contracts (shared, ADR-0003)

- HTTP: `GET /api/threads`, `GET /api/threads/:id`, `POST /api/threads` (first message), `POST /api/threads/:id/messages`,
  `POST /api/messages/:id/answer` (decision/question cards), `POST /api/permissions/:id` (allow/deny),
  `GET /api/tasks`, `GET /api/tasks/:id`, `GET /api/tasks/:id/artifacts/:name`, `POST /api/tasks/:id/{cancel,retry,stop}`,
  `GET /api/sessions/:id`, `GET /api/runs/:id/events`, `POST /api/sessions/:id/messages`, `GET /api/overview`,
  `GET /api/config`, `GET /api/connections`, `GET /api/stream` (SSE).
- Internal (MCP server → engine, run token required): `POST /api/agent/tools/:tool`, `POST /api/agent/permissions` (long-poll until decided or timeout).
- SSE: notification events `{ type: 'thread'|'task'|'run'|'run_event'|'overview'|'config', id, data? }`; the web
  patches or invalidates Query caches; after a reconnect it invalidates everything (UI "catches up").
- Wire details fixed by T15: SSE frames are unnamed `message` events whose `data` is one JSON `StreamEvent`
  (plus `: ping` comments as heartbeat); list routes return plain arrays; `POST /api/threads` returns `ThreadDetailDto`,
  `POST /api/sessions/:id/messages` returns `MessageDto`, every other POST returns `204` (the web invalidates queries).
- MCP tools — dispatcher: `create_task`, `list_tasks`, `cancel_task`, `send_to_task`, `reply`; worker: `report_stage`,
  `ask_owner`, `submit_spec_for_approval`, `report_checks`, `report_pr`, `log_note`; both: `approve`.

### Config (ADR-0006) — `~/.jarvis/jarvis.config.json`

`repo { path, remote, baseBranch }`, `limits { maxConcurrentWorkers=1, checkRetries=3, ciFixRounds=2, reviewRounds=3,
taskTimeoutMinutes=60, maxTurnsPerRun=60, maxBudgetUsdPerRun=3, dailyBudgetUsd=20, permissionTimeoutMinutes=30,
stallMinutes=10 }`, `watch { pollSeconds=60 }`, `models { dispatcher, worker, reviewer }` (`sonnet`),
`allowlist { githubReviewers[], autoAllowedCommands[] }`, `connectors { notionRoot?, googleFolder? }`,
`engine { port=4310, claudeBinary='claude' }`. No secret fields. Re-read on change; a run keeps the values it started with.

## Phases and tasks

Legend: **Owned** = paths the task may create/edit. **AC** = requirement IDs it must satisfy. **Verify** = what the
implementer runs before reporting; the phase gate re-runs it.

### Phase 0 — Scaffold (gate: install + empty test/typecheck green, Postgres healthy)

**T01 · infra · Monorepo scaffold**
- Owned: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc.json`,
  `.prettierignore`, `.nvmrc`, `compose.yaml`, `docker/`, `.gitignore`, `.env.example`, `jarvis.config.example.json`,
  `{shared,engine,web}/{package.json,tsconfig.json,vitest.config.ts,AGENTS.md}`, `engine/drizzle.config.ts`,
  `web/{vite.config.ts,index.html,playwright.config.ts}`, `web/src/main.tsx` (placeholder), `AGENTS.md` (Modules table rows only).
- Do: pnpm workspace `shared`, `engine`, `web` (ADR-0002); all manifests with the exact versions above (no other deps);
  root scripts `dev` (engine + web in parallel), `test`, `typecheck`, `lint`, `format:check`; engine scripts `dev`,
  `start`, `test`, `test:unit`, `test:int`, `typecheck`, `db:generate`, `db:migrate`; Vitest projects `unit`/`int` in engine;
  compose Postgres 18 on `127.0.0.1:5433` with init script creating `jarvis_test`; `.env.example` with
  `DATABASE_URL=postgres://jarvis:jarvis@127.0.0.1:5433/jarvis`; `.gitignore` covers `.env`, `jarvis.config.json`, `node_modules`, `dist`, `test-results`.
- AC: NFR-01 (partially), ADR-0002, ADR-0007 Confirmation (`git check-ignore .env jarvis.config.json`).
- Verify: `pnpm install`, `pnpm typecheck`, `pnpm test` (passWithNoTests), `docker compose up -d` healthy.

### Phase 1 — Contracts (gate: shared tests + typecheck)

**T02 · core · Shared contracts** — depends T01
- Owned: `shared/src/**`.
- Do: `enums.ts` (TaskStage, Role, RunStatus, MessageKind, WaitingFor, RunEventKind), `config.ts` (JarvisConfig schema with
  defaults above, readable error formatting helper), `api/*.ts` (request bodies + DTOs for every route above),
  `stream.ts` (SSE notification union), `run-event.ts` (normalised RunEvent), `mcp.ts` (input schemas per tool,
  `toolsByRole` map), `index.ts` barrel. Imports only `zod`.
- AC: LIM-01, LIM-02 (schema side), ADR-0005 (no identity fields in tool inputs), ADR-0006 (no secret fields).
- Verify: `pnpm --filter @jarvis/shared test typecheck` — tests: defaults, invalid config error paths, tool schemas reject `taskId`/`threadId`.

### Phase 2 — Domain and application core (gate: unit tests, architecture test)

**T03 · core · Domain** — depends T02
- Owned: `engine/src/domain/**`, `engine/src/architecture.test.ts`.
- Do: `task.ts` (transition table above as data + `transition(task, to, cause)` returning new task + journal event or
  `DomainError`; counters and `canRetryChecks/canFixCi/canReviewRound`), `thread.ts`, `message.ts` (card answer once),
  `run.ts`, `permission.ts`, `limits.ts` (`LimitPolicy`: budget left, can start run, task timed out), `watch.ts`
  (pure `diffPullRequest(prev, next, { botLogin, reviewers })` → `CodeHostChange[]`: `ci_completed{conclusion}`,
  `review{state}`, `comment{id}`; idempotent; ignores bot/non-allowlist; only the current head SHA — CI-06, CI-07, CI-09),
  `waiting-for.ts`, `errors.ts`. Architecture test enforces ADR-0003 layer rules and ADR-0008/0009/0010 import rules.
- AC: ST-03 (journal event per transition), CI-06, CI-07, CI-09, LIM-03/04 (policy), WRK-11 (timeout rule).
- Verify: `pnpm --filter @jarvis/engine test:unit typecheck`.

**T04 · core · Application: conversation and task lifecycle** — depends T03
- Owned: `engine/src/application/ports/**`, `engine/src/application/testing/**` (in-memory fakes of all ports),
  `engine/src/application/conversation/**`, `engine/src/application/tasks/**`.
- Do: use cases `PostOwnerMessage` (routing rules), `CreateTask` (DSP-01: task + worktree + branch + reply),
  `SubmitSpec`, `AnswerDecision` (approve / request changes), `AskOwner`, `AnswerQuestion`, `ReportStage`,
  `ReportChecks` (WRK-07 retries → Failed), `ReportPr`, `CancelTask` (DSP-06), `ListTasks`/status text (DSP-05),
  `SendToTask`, `Reply`, `UpdateStatusCard` (SLK-07: one status message per task, updated in place).
- AC: SLK-01, SLK-02, SLK-06, SLK-07, DSP-01, DSP-03 (no file effects in dispatcher paths), DSP-04, DSP-05, DSP-06, DSP-07, WRK-04, WRK-05, WRK-07, WRK-09 (state side), CI-01.
- Verify: unit tests with fakes for every use case incl. double answer, cancel during run, answer after cancel.

**T05 · core · Application: runs, slots, limits, permissions, recovery, CI follow-up** — depends T04.
Executed as two sequential halves: **T05a** (runs, `RunScheduler`, budget, `RunRegistry`, permissions, `StopRun`, `SendToSession`) and **T05b** (`HandleCodeHostChange`, `DetectStalls`, `TaskTimeouts`, `ResumeAfterRestart`, `CodeHost` port).
- Owned: `engine/src/application/runs/**`, `engine/src/application/permissions/**`, `engine/src/application/code-host/**`, `engine/src/application/recovery/**`.
- Do: `RunScheduler` (worker slots, FIFO queue of tasks/events with position messages, budget pause/resume — DSP-08, LIM-04),
  `StartRun` (prompt assembly incl. USER.md, artifacts dir, pending owner input; records run; consumes `AgentRunner`
  events → run events, usage, session id, completion status incl. `limit_reached`), `StopRun`, `RetryStage`,
  `RequestPermission`/`AnswerPermission` (card, timeout → deny, journal — SLK-05), `HandleCodeHostChange`
  (CI-03…CI-05, CI-08, flaky retry once), `DetectStalls` (DSP-09), `ResumeAfterRestart` (ST-04, ST-05: interrupted runs,
  expired permissions, re-queue active tasks), `TaskTimeouts` (WRK-11).
- AC: DSP-02, DSP-08, DSP-09, WRK-11, CI-02…CI-05, CI-08, ST-04, ST-05, LIM-03, LIM-04, LIM-05, SLK-05, ADM-06, NFR-04.
- Verify: unit tests with fakes: 2 tasks / 1 slot queue, budget reached mid-day, restart with a running run, CI fail → fix
  → rounds exhausted → Blocked, permission timeout.

### Phase 3 — Infrastructure (gate: unit + integration tests, ADR greps, live CLI smoke)

T06–T10 run in parallel (disjoint paths). T06 and T09 only need the T04 ports and start alongside T05a; T07, T08, T10 wait for T05b (repository, runner and code-host ports).

**T06 · backend · Config, env and Jarvis Home**
- Owned: `engine/src/infrastructure/config/**`, `engine/src/infrastructure/clock/**`.
- Do: `loadEnv` (only place reading `process.env`; startup guard for `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/
  `CLAUDE_CODE_USE_BEDROCK`/`CLAUDE_CODE_USE_VERTEX` with a clear message), `JarvisHome` paths, `FileConfigProvider`
  (Zod validation with field-level errors, `fs.watch` reload — LIM-02, LIM-05, PRF-03), `redactSecrets(text)`, system clock.
- AC: SEC-04, SEC-05, LIM-01, LIM-02, LIM-05; ADR-0006/0007 Confirmation (`config.test.ts`, redactor test).

**T07 · backend · Postgres persistence**
- Owned: `engine/src/infrastructure/db/**`, `engine/drizzle/**`, `engine/test/db.ts`.
- Do: Drizzle schema (Data section), first migration, `pg` pool, repositories implementing the ports, `UnitOfWork`
  with transactional `task_events`; `T-<n>` id sequence; integration harness on `jarvis_test` (migrate + truncate).
- AC: ST-01, ST-02, ST-03, NFR-04; ADR-0010 Confirmation (integration test proving journal row in the same tx; rollback test).
- Verify: `pnpm --filter @jarvis/engine test:int`.

**T08 · backend · Claude CLI runner**
- Owned: `engine/src/infrastructure/claude/**`, `engine/test/fake-claude/**`.
- Do: `buildRunArgs` (pure), `buildChildEnv` (pure), `writeRunFiles` (`mcp.json` pointing at the MCP entry with
  `JARVIS_API_URL` + run token, `settings.json` from `agent/settings/worker.json` + config allow-list with denies for
  base-branch push, `--force`, `gh pr merge`, branch deletion — SEC-01, SEC-02), `parseStreamJson` (line → RunEvent[]),
  `ClaudeCliRunner` (spawn, stdin stream-json writes, graceful stop then kill, exit mapping); scripted fake CLI.
  From T14: the run's system prompt file is `agent/SOUL.md` + `agent/prompts/<role>.md` concatenated into
  `<runDir>/system.md` (the CLI takes one `--append-system-prompt-file`); generated `settings.json` adds denies
  for `repo.baseBranch` and the delete-by-refspec form `git push <remote> :<branch>`; the first user message
  follows the "Run context" block contract in `agent/prompts/worker.md`.
- AC: ADM-03 (event source), SEC-01, SEC-02, SEC-04; ADR-0004, ADR-0009 (settings test), ADR-0011 Confirmation tests.
- Gate smoke (orchestrator, live): run `ClaudeCliRunner` once with `--model haiku --max-turns 1` and a one-line prompt;
  the parser must produce `system`, `text`, `result` events and a cost.

**T09 · backend · Git worktrees and artifacts**
- Owned: `engine/src/infrastructure/git/**`, `engine/src/infrastructure/artifacts/**`.
- Do: `GitWorktreeManager` (fetch base, `worktree add -b jarvis/<id>` under `~/.jarvis/worktrees/<id>`, idempotent,
  never deletes), `FileArtifactStore` (`~/.jarvis/tasks/<id>/` read/list with "not written yet", change notifications).
- AC: DSP-01 (branch), WRK-01…WRK-03/WRK-09 (artifact files exist and are served), SEC-02.
- Verify: tests on a temp git repo.

**T10 · backend · GitHub code host**
- Owned: `engine/src/infrastructure/github/**`.
- Do: `GitHubCodeHost` with `@octokit/rest`: PR snapshot (head SHA, check runs of head, reviews, issue + review comments
  with authors), bot login, connection check (repo access, token scopes) — never logs the token.
- AC: CI-01, CI-03, CI-06, CI-07, ADM-08 (GitHub row); ADR-0009 Confirmation.
- Verify: tests with an injected fake `fetch`.

### Phase 4 — Presentation, composition, agent definition (gate: engine boots, API smoke, fake-CLI flow test)

**T11 · backend · HTTP API, SSE and composition root** — depends T06–T10
- Owned: `engine/src/presentation/http/**`, `engine/src/infrastructure/sse/**`, `engine/src/container.ts`, `engine/src/main.ts`.
- Do: Fastify on `127.0.0.1` (ADM-07); routes from *Wire contracts* validated with shared schemas; one error mapper;
  internal agent routes with run-token auth; `/api/stream` SSE fan-out with heartbeat; `container.ts` wires adapters;
  `main.ts`: env guard → config → migrate → `ResumeAfterRestart` → listen → timers.
- AC: ADM-01…ADM-08 (API side), SEC-03 (text stored and returned as data), NFR-08, ADR-0008.
- Verify: Fastify `inject` tests per route; full-flow test using the fake CLI: message → task → spec card → approve →
  report_pr → PR Open.

**T12 · backend · Jarvis MCP server** — depends T11 (internal routes)
- Owned: `engine/src/presentation/mcp/**`.
- Do: stdio server (`@modelcontextprotocol/sdk`) started per run from `mcp.json`; registers only `toolsByRole[role]`;
  every tool is a thin call to the internal API; `approve` long-polls and returns the CLI's allow/deny shape; clear
  error when the engine is down.
- AC: ADR-0005 Confirmation (`tools.test.ts`), SLK-05, DSP-03, SEC-03.
- Gate smoke (live): one worker run with `--model haiku` that calls `log_note` — the note appears in the task journal.

**T13 · backend · Timers: watcher, stalls, timeouts, budget** — depends T11
- Owned: `engine/src/presentation/watcher/**`, `engine/src/presentation/timers/**`.
- Do: watcher loop every `watch.pollSeconds` over active watches → `diffPullRequest` → `HandleCodeHostChange` (no model
  calls while nothing changed); stall/timeout/permission-expiry timers; all stoppable for tests.
- AC: CI-02, CI-09, NFR-03, DSP-09, WRK-11.

**T14 · docs · Agent definition plugin** — depends T02 (tool names); parallel to T11–T13
- Owned: `agent/**`.
- Do: plugin manifest, `SOUL.md`, `USER.example.md`, `prompts/dispatcher.md` (no code, tools only, knowledge answers
  with sources), `prompts/worker.md` (SDD loop: context → spec → plan → approval → implement → checks → review → PR →
  result, one question when blocked, untrusted input rule), subagents `context-researcher`, `plan-verifier`,
  `implementer`, `reviewer`, skill `sdd-flow`, templates for the five artifacts, `settings/worker.json`.
- AC: WRK-01…WRK-10, CTX-01…CTX-05, PRF-01, PRF-02, PRF-04, SEC-03, ADR-0011 (no `USER.md` in git).

### Phase 5 — Live vertical slice (orchestrator gate, real `claude`, owner present)

Not an implementer task. With a scratch target repo that satisfies CON-04 (`AGENTS.md` with check commands):
knowledge question (DSP-07) → small code task → spec/plan approval card → implementation → checks → review →
(with `GITHUB_TOKEN` of the bot and a real remote) draft PR → watcher sees CI. Record cost of the run (open question
"Перевірити до старту"). Findings become fix tasks before Phase 6 merges.

### Phase 6 — Web app (gate: unit/RTL tests, typecheck, build, e2e)

T15 first; T16–T19 in parallel (disjoint feature folders); T20 last. Provisional styles until the owner's design
(ADR-0012); structure, states and copy follow `docs/specs/web-ui-design.md`.

**T15 · ui · Shell, API layer, live cache** — depends T02 (can start right after Phase 1)
- Owned: `web/src/api/**`, `web/src/app/**`, `web/src/styles/**`, `web/src/components/**`, `web/src/main.tsx`.
- Do: router with all routes + Not found; shell (nav, `LOCAL · NO AUTH`, usage meter, connection indicator,
  waiting-for-me counter, budget banner); typed API client from shared schemas; SSE hook patching/invalidating Query;
  shared components (`StageBadge`, `StageStepper`, `Markdown` via react-markdown, `EmptyState`, `ConfirmDialog`, `UsageMeter`).
- AC: ADM-07, NFR-08, UI "Загальні стани", ADR-0012 Confirmation.

**T16 · ui · Chat** — Owned `web/src/features/chat/**` — SLK-01…SLK-07, DSP-04…DSP-07, WRK-04, WRK-05 (all card types,
one-answer rule, queued messages, thread menu, empty/offline/budget states).

**T17 · ui · Tasks and Task detail** — Owned `web/src/features/tasks/**` — ADM-01, ADM-02, ADM-06, CI-01…CI-09 views
(timeline, artifacts tabs, PR/CI/review, runs, journal, actions with confirm).

**T18 · ui · Session console** — Owned `web/src/features/sessions/**` — ADM-03, ADM-04, ADM-06 (event stream with nested
subagent events, filters, search, jump to latest, collapsed long output, send/stop/retry).

**T19 · ui · Overview, Config, Connections** — Owned `web/src/features/{overview,config,connections}/**` — ADM-05,
ADM-08, DSP-08, DSP-09, NFR-03.

**T20 · e2e · Playwright happy path** — depends T15–T19 — Owned `web/e2e/**`: engine + fake CLI: new thread → task →
approve spec → PR Open → watcher change (fake code host scenario) → Done; budget pause banner; permission card allow.

### Phase 7 — Verification and docs (gate: everything green, live demo run)

- Orchestrator: ADR Confirmation sweep over the whole repo, requirement traceability (every ID above → code/test),
  README "run in one command" (NFR-01, NFR-06), live demo task on the owner's chosen repo (NFR-02, NFR-07).

## Dependency DAG

```
T01 → T02 → T03 → T04 → T05 → {T06, T07, T08, T09, T10} → T11 → {T12, T13} → Phase 5 → T20 → Phase 7
           T02 → T14 (parallel to Phase 3–4)
           T02 → T15 → {T16, T17, T18, T19} (parallel to engine phases) → T20
```

## Needed from the owner (by phase)

| When | What |
|---|---|
| any time | Accept or change ADR-0002…0013 |
| Phase 5 | Target repo for the demo (open question in the spec) and the GitHub bot account + fine-grained PAT in `~/.jarvis/.env` |
| Phase 5 | Who reviews in the demo (`allowlist.githubReviewers`) |
| Phase 6 | Claude Design output, if it should replace provisional styles in this iteration |
| later | Notion / Google Docs MCP servers and tokens (CTX-02/03 stay "source unavailable → Blocked" until configured) |

## Risks

- Fastify 5.12 declares Node ≥ 22.22; local Node is 22.17 (works in Agent Ops Center, warning only). Upgrade Node when convenient.
- stream-json format drift between the fake CLI and the real one — covered by the live smoke in Phase 3 and Phase 5.
- `--max-budget-usd` and `total_cost_usd` are estimates (ADR-0006): the budget is a brake, not a meter.
- The owner's personal `~/.claude` must not leak into runs (`--setting-sources project,local`, `--strict-mcp-config`); verified in the Phase 3 smoke.
