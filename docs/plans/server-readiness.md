# Implementation Plan: server readiness, health, telemetry, session economics

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Jarvis runs unattended on the VPS from ADR-0016, the owner can tell at a glance whether it is alive
and what every agent session cost and did, and the Linux setup is rehearsed on the laptop before the server exists.

**Architecture:** No new runtime in the engine. Liveness is one HTTP route plus a heartbeat ping; "what happened"
is the engine's existing JSON log on stderr (raised to `info`) and Claude Code's built-in OpenTelemetry export,
both shipped by one Grafana Alloy agent on the host; "what it cost" is the `runs` table the engine already fills,
exposed through one usage query and one admin page.

**Tech Stack:** Fastify 5, Drizzle, Vitest (ADR-0011 fakes), React/TanStack Query, Docker (Ubuntu 24.04 image
for the rehearsal), systemd, Infisical CLI, Grafana Alloy + Grafana Cloud (OTLP), healthchecks.io.

**Spec:** `docs/specs/abstract-project-spec.md` (`ADM-*`, `LIM-04`, `SEC-05`, `NFR-*`), ADR-0016, ADR-0015,
`docs/architecture/deployment.md`. New decisions this plan needs: ADR-0016 (runtime image as rehearsal), ADR-0016
(telemetry). Both are written in Phase 0 and treated as binding once the owner accepts them.

## Global Constraints

- No `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` anywhere; the start-up guard in `engine/src/main.ts` stays (ADR-0003).
- Child `claude` env is an allow-list in `engine/src/infrastructure/claude/child-env.ts`; every new variable is added
  there explicitly and tested (ADR-0015).
- No new engine dependency without an ADR. This plan adds **none** to `engine/package.json` (OTel comes from the
  CLI and from Alloy, not from the engine).
- Engine, web and Postgres bind `127.0.0.1` only (ADR-0016). The runtime image publishes ports on `127.0.0.1` too.
- Secrets: names only in `.env.example`; values in `~/.jarvis/.env` (laptop) or Infisical `prod` (server).
- Logs never contain secrets: everything goes through `ConsoleLogger`, which redacts (ADR-0015).
- Integration tests use `jarvis_test` on 127.0.0.1:5433; no test runs the real `claude` (ADR-0011).
- Conventional commits; one commit per task.

## Review Focus

1. **`claude` login expired on the server.** `/api/connections` must show `warning` with the days left before it
   expires and `failed` after; a run must not start on an expired login (test in Task 2.3).
2. **Postgres down while the engine is up.** `/api/health` returns 503 with `database: "failed"`; the engine does
   not crash (Task 2.2).
3. **Alloy or healthchecks.io unreachable.** The heartbeat is fire-and-forget: a failed ping is logged at `warn`
   and never blocks a timer tick (Task 2.5).
4. **A run that ends by `max_turns` or budget, not by success.** `runs.stop_reason` records it, and the usage
   page shows it, so "went badly" is visible without reading events (Task 4.1).
5. **`OTEL_*` leaking into a run when telemetry is off.** With `telemetry.enabled: false` the child env contains no
   `OTEL_*` and no `CLAUDE_CODE_ENABLE_TELEMETRY` (Task 3.2).

---

## Phase 0: decisions (owner accepts before code)

### Task 0.1: ADR-0016 — Linux runtime image as a rehearsal of the server, not a deployment target

**Files:** Create `docs/decisions/architecture/0017-linux-runtime-image-as-server-rehearsal.md`; modify
`docs/decisions/architecture/README.md` (index row).

- [ ] Write the ADR in the MADR shape of ADR-0016: context (macOS keeps the login in Keychain, Linux in
      `~/.claude/.credentials.json`; headless `/login`; non-root user; journald), options (rehearse in a container
      on the laptop; rehearse on a throwaway Hetzner box; do not rehearse), decision (container, `compose.yaml`
      profile `server`, same `pnpm` scripts, ADR-0016 unchanged), consequences, confirmation rule:
      `RULE: compose profile server publishes only 127.0.0.1 ports. CHECK: grep -n "127.0.0.1" compose.yaml`.
- [ ] Commit: `docs: ADR-0016 linux runtime image as server rehearsal`.

### Task 0.2: ADR-0016 — Telemetry: engine logs via journald, Claude Code OTel export, one Alloy agent, Grafana Cloud

**Files:** Create `docs/decisions/architecture/0018-telemetry-journald-claude-otel-grafana-cloud.md`; modify README index.

- [ ] Options: (a) engine with `@opentelemetry/sdk-node` + collector; (b) **engine logs only, CLI OTel, Alloy
      ships both to Grafana Cloud**; (c) Postgres-only (admin page, no external service); (d) Sentry for errors.
- [ ] Decision (b) + (c) together: Grafana Cloud free tier receives OTLP from Alloy; Alloy reads journald units
      `jarvis-engine`, `jarvis-web` and forwards OTLP from the CLI (`127.0.0.1:4318`). Liveness is a
      healthchecks.io heartbeat. Per-session economics stay in Postgres and are the source of truth for budgets.
- [ ] Record what is **not** done: no OTel SDK in the engine (no dependency, no ADR for one), no Sentry, no
      Prometheus on the host, no public probe (the tailnet is private; external uptime checkers cannot reach it).
- [ ] Confirmation rules: `RULE: engine has no @opentelemetry dependency. CHECK: grep -c opentelemetry engine/package.json → 0`;
      `RULE: OTEL_* reach a child only when telemetry.enabled. CHECK: engine/src/infrastructure/claude/env.test.ts`.
- [ ] Commit: `docs: ADR-0016 telemetry via journald, claude otel and grafana cloud`.

**Gate 0:** owner reads both ADRs and sets `status: accepted` (or edits). Nothing below starts before that.

---

## Phase 1: environment parity (ADR-0016)

### Task 1.1: runtime image and compose profile

**Files:** Create `docker/runtime/Dockerfile`, `docker/runtime/entrypoint.sh`; modify `compose.yaml`, `README.md`
("Rehearse the server setup" section), `docs/architecture/deployment.md` (link).

**Interfaces:** Produces image `jarvis-runtime` with user `jarvis` (uid 1000), `HOME=/home/jarvis`, Node 22, pnpm
via corepack, git, gh, Docker CLI absent (Postgres is a sibling service), Claude Code CLI installed with
`curl -fsSL https://claude.ai/install.sh | bash` as `jarvis`. Volumes: `./:/home/jarvis/jarvis` (checkout),
`jarvis-home:/home/jarvis/.jarvis`, `claude-home:/home/jarvis/.claude`, plus `${TARGET_REPO}:/work/repo` for the
working repository. Named volumes also cover the root and every package `node_modules`: the bind-mounted checkout
carries the host's macOS install, whose binaries cannot execute under Linux.

- [ ] Dockerfile from `ubuntu:24.04`; apt `git gh curl ca-certificates`; NodeSource Node 22; `corepack enable`;
      `useradd -m -u 1000 jarvis`; `USER jarvis`; install Claude Code; `ENV CLAUDE_CONFIG_DIR=/home/jarvis/.claude`.
- [ ] `entrypoint.sh`: `pnpm install --frozen-lockfile` on every start (about a second once the volume is
      populated, and the only way a stale or foreign install is corrected), then `exec "$@"`.
- [ ] `compose.yaml`: services `engine` and `web` under `profiles: [server]`, `build: docker/runtime`,
      `depends_on: postgres: condition: service_healthy`, `DATABASE_URL=postgres://jarvis:jarvis@postgres:5432/jarvis`,
      ports `127.0.0.1:4310:4310` and `127.0.0.1:5180:5180`, commands `pnpm --filter @jarvis/engine start` and
      `pnpm --filter @jarvis/web exec vite preview --host 0.0.0.0` (the SPA must bind all container interfaces; the
      host mapping is loopback). Engine `--host` likewise: check `engine/src/container.ts` `listen` host; if hard-coded
      `127.0.0.1`, add env `JARVIS_LISTEN_HOST` (default `127.0.0.1`) read in `infrastructure/config/env.ts`.
- [ ] README section, exact commands:
      ```sh
      docker compose --profile server build
      docker compose --profile server run --rm engine claude        # /login, paste code; credentials land in claude-home
      docker compose --profile server run --rm engine claude -p "ping"
      docker compose --profile server up -d
      curl -s http://127.0.0.1:4310/api/health
      ```
- [ ] Verify by hand on the laptop: all five commands succeed; `docker compose --profile server run --rm engine
      ls -la /home/jarvis/.claude/.credentials.json` shows mode `600`.
- [ ] Commit: `build: linux runtime image and compose profile server (ADR-0016)`.

### Task 1.2: env test for the listen host (only if 1.1 added `JARVIS_LISTEN_HOST`)

**Files:** Modify `engine/src/infrastructure/config/env.ts`, `env.test.ts`.

- [ ] Test `loadEnv` returns `listenHost: '127.0.0.1'` when unset and the given value when set; refuses `0.0.0.0`
      unless `JARVIS_INSIDE_CONTAINER=1` is also set (keeps ADR-0016's loopback rule on hosts).
- [ ] Run `pnpm --filter @jarvis/engine test:unit`; commit `feat(engine): configurable listen host for containers`.

**Gate 1:** `docker compose --profile server up -d` on the laptop, `/api/connections` shows `claude: ok`, and a
dispatcher run with `--model haiku` answers in the web chat served from the container.

---

## Phase 2: server readiness (ADR-0015/0016 TODOs, health, liveness)

### Task 2.1: deploy files in the repo

**Files:** Create `scripts/with-secrets.sh`, `deploy/systemd/jarvis-engine.service`, `deploy/systemd/jarvis-web.service`,
`deploy/README.md`; modify `web/vite.config.ts` (preview block), `docs/architecture/deployment.md` (remove TODOs,
point to `deploy/`).

- [ ] `with-secrets.sh`: if `INFISICAL_CLIENT_ID` is set → `infisical login --method=universal-auth` (token to
      `INFISICAL_TOKEN`) then `exec infisical run --env=${JARVIS_ENV:-prod} --projectId "$INFISICAL_PROJECT_ID" -- "$@"`;
      otherwise `exec "$@"` (laptop fallback, ADR-0015). `set -euo pipefail`; no secret echoed.
- [ ] Units as sketched in `deployment.md`, plus `Restart=on-failure`, `RestartSec=5`, `Environment=NODE_ENV=production`,
      and `ExecStartPost=/usr/bin/curl -fsS --retry 10 --retry-connrefused http://127.0.0.1:4310/api/health` on the
      engine (so a bad start fails the unit, not just logs).
- [ ] `vite.config.ts`: `preview: { host: '127.0.0.1', port: 5180, allowedHosts: ['.ts.net'], proxy: <same as server> }`;
      extract the proxy object to a const used by both `server` and `preview`.
- [ ] `deploy/README.md`: rebuild runbook (restore snapshot → `claude -p ping` → re-login if needed → `systemctl status`
      → `/api/health`) and the update sequence from `deployment.md §5`.
- [ ] Commit: `build: systemd units, infisical wrapper and vite preview for the VPS (ADR-0016, ADR-0015)`.

### Task 2.2: `GET /api/health`

**Files:** Create `engine/src/application/queries/get-health.ts`, `engine/src/presentation/http/routes/health.ts`;
modify `shared/src/` (add `HealthSchema`), `engine/src/application/create-application.ts`, `presentation/http/server.ts`
(register route), `engine/src/presentation/http/api.test.ts`.

**Interfaces:** Produces `HealthSchema = { status: 'ok'|'degraded'|'failed', uptimeSeconds: number, database:
'ok'|'failed', claude: 'ok'|'warning'|'failed'|'unknown', activeRuns: number, version: string }` in `@jarvis/shared`;
`GetHealth.execute(): Promise<Health>`; route answers 200 for `ok`/`degraded`, 503 for `failed`.

- [ ] Test (api.test.ts): with the fake DB ping rejecting, response is 503 and body `database: 'failed'`; with all
      green, 200 and `activeRuns` equals the number of running runs in the fake repository.
- [ ] `GetHealth` uses a new port `DatabasePing { ping(): Promise<void> }` (implemented in `infrastructure/db` as
      `SELECT 1`) and the **last cached** result of the claude probe (never execs on a health call; `unknown` before
      the first probe). `version` = `engine/package.json` version via the existing config loader, not `fs` in the route.
- [ ] Run `pnpm --filter @jarvis/engine test`; commit `feat(engine): GET /api/health for systemd and monitoring`.

### Task 2.3: login expiry in the claude probe

**Files:** Modify `engine/src/infrastructure/connections/claude-cli-probe.ts`, `connections.test.ts`; `shared/src`
connection status enum if it lacks `warning`.

- [ ] Parse `loginExpiresAt` (ISO string) from `claude auth status --json`. Rules: expired → `failed`,
      summary `Login expired on <date>. Run \`claude\` and /login.`; < 7 days → `warning`, summary
      `Login expires in N days`; else `ok` with detail `Expires: <date>`.
- [ ] Tests for the three branches with a fixed `now`.
- [ ] Run tests; commit `feat(engine): warn before the claude login expires`.

### Task 2.4: `info` logging of the run lifecycle

**Files:** Modify `engine/src/application/ports/logger.ts` (add `info`), `engine/src/infrastructure/logging/console-logger.ts`
(+ test), `engine/src/main.ts` (`LOG_LEVEL` from env `JARVIS_LOG_LEVEL`, default `info`), and the use cases that
start/finish runs, change task stage, create/answer permissions, and the watcher tick.

**Interfaces:** `Logger.info(message: string, context?: LogContext)`. Context keys fixed for Loki queries:
`event` (one of `run.started`, `run.finished`, `task.stage`, `permission.requested`, `permission.answered`,
`watch.polled`, `heartbeat.failed`), `runId`, `sessionId`, `taskId`, `threadId`, `role`, `model`, `costUsd`,
`turns`, `stopReason`, `durationMs`.

- [ ] Test: `ConsoleLogger` at level `warn` drops `info`; at `info` writes it with `event`.
- [ ] Add the calls; one line per lifecycle event, nothing per stream-json event (those live in `run_events`).
- [ ] Run `pnpm --filter @jarvis/engine test`; commit `feat(engine): info-level lifecycle log lines`.

### Task 2.5: heartbeat to healthchecks.io

**Files:** Create `engine/src/infrastructure/heartbeat/http-heartbeat.ts` (+ test with a fake `fetch`),
`engine/src/presentation/timers/heartbeat.ts`; modify `engine/src/application/ports/` (port `Heartbeat { beat(): Promise<void> }`),
`presentation/timers/index.ts`, `.env.example` (`HEARTBEAT_URL=`), `infrastructure/config/env.ts` (+ test).

- [ ] Timer every 60 s: run `GetHealth`; `status !== 'failed'` → `fetch(HEARTBEAT_URL)`, else `fetch(HEARTBEAT_URL + '/fail')`.
      Errors → `logger.warn('heartbeat failed', { event: 'heartbeat.failed' })`, never thrown. No URL → timer not started.
- [ ] Test: the timer calls `/fail` on a failed health and swallows a rejected fetch.
- [ ] Commit `feat(engine): optional heartbeat ping (HEARTBEAT_URL)`.

### Task 2.6: connectors without a browser on the server

**Files:** Modify `.env.example` (`GOOGLE_SERVICE_ACCOUNT_JSON=`, commented `GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN=`),
`jarvis.config.example.json` (nothing new; `connectors.googleFolder` already exists), `agent/` or `~/.jarvis/mcp/servers.json`
example (`docs/architecture/connectors.md` names the variables), `engine/src/infrastructure/connections/create-connection-checks.ts`
(+ `connections.test.ts`), `deploy/README.md`.

**Interfaces:** Follows `docs/architecture/connectors.md`: service account first, OAuth refresh token in Infisical
(way 1) second, SSH-tunnel OAuth on the server (way 2) only as a documented fallback.

- [ ] Pick the Google Docs MCP server: it must read either a service-account key or an OAuth refresh token from
      environment variables. Record the choice, its npm name and version, and the exact variables in `connectors.md`
      "Per connector"; add the `servers.json` snippet to `agent/README.md`.
- [ ] `connectorProbe` for Google reports `not_configured` unless `GOOGLE_SERVICE_ACCOUNT_JSON` **or** all three
      `GOOGLE_OAUTH_*` are set; detail says which mode. Test both modes and the missing case.
- [ ] `deploy/README.md`: section "Connectors" with the way-2 tunnel commands verbatim from `connectors.md`, marked
      "only if the chosen server cannot read its token from env".
- [ ] Commit `docs(connectors): service account or env-held oauth token; ssh-tunnel fallback`.

**Gate 2:** on the laptop, `pnpm dev` → `curl -i /api/health` 200; stop Postgres → 503 within one call; log lines
appear as JSON with `event`; with a real healthchecks.io URL the check turns green.

---

## Phase 3: telemetry (ADR-0016)

### Task 3.1: config block `telemetry`

**Files:** Modify `shared/src/config` schema (+ test), `jarvis.config.example.json`, `.env.example`.

**Interfaces:** `telemetry: { enabled: boolean (default false), otlpEndpoint: string (default 'http://127.0.0.1:4318'),
protocol: 'http/protobuf' }`. Secrets (`OTEL_EXPORTER_OTLP_HEADERS` for Grafana Cloud) stay in `.env`, not in config.

- [ ] Zod schema with defaults; example JSON gets the block with `enabled: false`.
- [ ] Commit `feat(shared): telemetry config block`.

### Task 3.2: OTel variables into the child env

**Files:** Modify `engine/src/infrastructure/claude/child-env.ts`, `env.test.ts`; `run-context.ts` if the resource
attributes need run data.

- [ ] When `telemetry.enabled`: add `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`,
      `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=<protocol>`, `OTEL_EXPORTER_OTLP_ENDPOINT=<otlpEndpoint>`,
      `OTEL_LOG_USER_PROMPTS=0`, `OTEL_RESOURCE_ATTRIBUTES=service.name=jarvis-claude,jarvis.role=<role>,jarvis.run_id=<runId>,jarvis.task_id=<taskId|->,jarvis.session_id=<sessionId>`.
      A child never receives `OTEL_EXPORTER_OTLP_HEADERS` or any other Grafana Cloud credential: it exports to the
      local Alloy endpoint, and Alloy alone authenticates upstream (ADR-0016).
- [ ] Tests: disabled → no `OTEL_*`/`CLAUDE_CODE_ENABLE_TELEMETRY` key at all; enabled → the exact set above,
      `OTEL_LOG_USER_PROMPTS` is `0`, and no `OTEL_EXPORTER_OTLP_HEADERS` in the child env even when the engine has it.
- [ ] Commit `feat(engine): claude code otel export when telemetry.enabled`.

### Task 3.3: Alloy config and dashboard

**Files:** Create `deploy/alloy/config.alloy`, `deploy/alloy/README.md`, `deploy/grafana/jarvis-overview.json`.

- [ ] `config.alloy`: `loki.source.journal` for units `jarvis-engine.service`, `jarvis-web.service` with labels
      `unit`, `host`; `otelcol.receiver.otlp` on `127.0.0.1:4318` → `otelcol.exporter.otlphttp` to Grafana Cloud
      (credentials from `/etc/jarvis/alloy.env`, mode `0640`); journald lines parsed as JSON so `event`, `runId`,
      `taskId` become labels/fields.
- [ ] Dashboard panels: engine up (heartbeat age), runs started/finished per hour by role, cost per day vs
      `dailyBudgetUsd`, tokens by model (`claude_code.token.usage` by `type`), tool errors (`tool_result` events with
      `success=false`), rate-limit events, last 50 lifecycle lines.
- [ ] README: install Alloy on the VPS, where the env file goes, which Grafana Cloud stack tokens are needed.
- [ ] Commit `build(deploy): alloy pipeline and grafana overview dashboard (ADR-0016)`.

**Gate 3:** laptop with `telemetry.enabled: true`, Alloy running locally (`brew install grafana/grafana/alloy`),
one `--model haiku` run shows up in Grafana Cloud Explore as metrics with `jarvis.run_id` and as logs with the
engine's `run.finished` line.

---

## Phase 4: session economics in Postgres and the admin UI

### Task 4.1: stop reason and per-model usage on runs

**Files:** Modify `engine/src/infrastructure/db/schema.ts` (+ `pnpm --filter @jarvis/engine db:generate` migration),
`engine/src/domain/run.ts`, `engine/src/infrastructure/claude/stream-json.ts` (+ test), the run-finishing use case
(+ test), `shared/src` run schema.

**Interfaces:** `runs.stop_reason text` ∈ `success | max_turns | budget | error | rate_limited | cancelled | killed`
(from the `result` event's `subtype` and the existing `RATE_LIMIT` detector); `runs.model_usage jsonb` =
`{ [model]: { input, output, cacheRead, cacheWrite, costUsd } }` from the result event's `modelUsage`.

- [ ] Tests in `stream-json.test.ts` for `subtype: 'error_max_turns'` → `max_turns`, `is_error` + rate-limit text →
      `rate_limited`, `modelUsage` parsed.
- [ ] Migration + repository write; commit `feat(engine): record stop reason and per-model usage per run`.

### Task 4.2: usage query and endpoint

**Files:** Create `engine/src/application/queries/get-usage.ts` (+ unit test with fake repo), repository method in
`infrastructure/db` (+ int test), `engine/src/presentation/http/routes/usage.ts`; modify `shared/src` (`UsageSchema`),
`api.test.ts`.

**Interfaces:** `GET /api/usage?from=<ISO>&to=<ISO>&groupBy=day|session|task|model` →
`{ rows: [{ key, runs, costUsd, turns, tokens: {input, output, cacheRead, cacheWrite}, stopReasons: Record<string, number>, durationMs }], total: <same shape> }`.
Default window: last 7 days. Session rows carry `role`, `threadId`, `taskId`; task rows carry `status` and `stage`.

- [ ] Int test: three runs over two sessions → `groupBy=session` returns two rows with summed tokens; `groupBy=day`
      buckets by `started_at` in UTC.
- [ ] Commit `feat(engine): usage query grouped by day, session, task or model`.

### Task 4.3: admin page "Usage"

**Files:** Create `web/src/pages/usage/UsagePage.tsx`, `UsagePage.module.css`, `web/src/api/usage.ts`, tests;
modify the router and admin nav.

- [ ] Controls: window (7/30 days, custom), group-by tabs. Table with the row shape above; stop reasons as text
      badges (never colour alone); daily total vs `dailyBudgetUsd` from `/api/config` shown as text `12.4 / 20 USD`.
- [ ] A session row links to the existing session/run events view, so "what went wrong" is one click from "how much".
- [ ] RTL test: renders rows from a stubbed `fetch`, switches group-by, shows the budget line.
- [ ] Commit `feat(web): usage page with per-session tokens and stop reasons`.

### Task 4.4: owner verdict on a task (optional, cheap, enables "good vs bad" later)

**Files:** schema `tasks.verdict text null` ∈ `good | bad`, `tasks.verdict_note text null`; `POST /api/tasks/:id/verdict`;
a two-button control on the task page.

- [ ] Only if the owner wants it after seeing Gate 4; otherwise drop this task, not the plan.

**Gate 4:** full `pnpm test`, typecheck, lint; a fake-claude int run yields a `runs` row with `stop_reason` and
`model_usage`; the Usage page shows it grouped by session.

---

## Dependency DAG

```
0.1 ─┐
0.2 ─┴─ Gate 0 ─┬─ 1.1 → 1.2 → Gate 1
                ├─ 2.1   2.2 → 2.5   2.3   2.4   2.6 → Gate 2
                ├─ 3.1 → 3.2   3.3 → Gate 3   (3.2 needs 2.4's `sessionId` on RunContext)
                └─ 4.1 → 4.2 → 4.3 → 4.4 → Gate 4
```

Phases 1, 2, 3, 4 can be worked in parallel after Gate 0; owned paths do not overlap except `shared/src` (3.1, 2.2,
4.1, 4.2 touch different files there).

## Needed from the owner

| Phase | Item |
|---|---|
| 0 | Accept ADR-0016 and ADR-0016 |
| 1 | Nothing (laptop only) |
| 2 | healthchecks.io account (free), one check URL; Infisical project `jarvis` with `dev`/`prod`; Google: service account key or a published OAuth desktop client (connectors.md) |
| 3 | Grafana Cloud stack (free), OTLP endpoint + token for Alloy |
| 4 | Decide on Task 4.4 after seeing the Usage page |

## Risks

- Claude Code OTel variable names and metric names follow the CLI's "Monitoring usage" docs; verify against the
  installed CLI version at Gate 3 before trusting the dashboard JSON.
- `vite preview` behind `tailscale serve` must accept the `.ts.net` host; if the proxy rewrites `Host`, add the
  exact host to `allowedHosts`.
- The runtime image rehearses Linux, not Hetzner: kernel, Docker-in-Docker and Tailscale are not covered. Keep
  `deploy/README.md` honest about that.
