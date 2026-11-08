---
status: superseded
date: 2026-11-08
decision-makers: ["Ivan Lapa"]  # owner accepted 2026-11-08; drafted by Claude
scope: ["engine/src/infrastructure/claude/**", "engine/src/infrastructure/logging/**", "engine/src/presentation/timers/**", "shared/src/config.ts", "deploy/alloy/**", "jarvis.config*.json"]
supersedes: []
superseded-by: ["0025"]
---

# ADR-0018: Observe the unattended server from parts that already exist: journald, Claude Code's own OTel export, one Alloy agent, Grafana Cloud

## Context and Problem Statement
Once Jarvis runs on the VPS (ADR-0015) nobody watches a terminal. The owner needs to know two things
without logging in over SSH: whether Jarvis is alive and what it is doing, and what each agent session
cost. The engine already writes structured JSON through a redacting logger (ADR-0007) and stores every
run, with cost, tokens and turns, in Postgres (ADR-0010). The `claude` CLI can export OpenTelemetry
metrics and logs by itself. The tailnet is private, so an external uptime checker cannot reach the
server. The engine has no telemetry dependency and a new one needs its own ADR.

## Considered Options
- `@opentelemetry/sdk-node` in the engine plus an OpenTelemetry collector on the host
- Engine log on stderr to journald, the CLI's built-in OTel export, one Grafana Alloy agent on the host forwarding both to Grafana Cloud (free tier)
- Postgres only: an admin Usage page, no external service
- Sentry for errors

## Decision Outcome
Chosen option: "engine logs to journald + CLI OTel + one Alloy agent to Grafana Cloud" **together with**
"Postgres only for session economics", because it adds no dependency to the engine, reuses the logger and
the `runs` table that exist, and splits the questions cleanly: Grafana answers "is it alive and what is it
doing", Postgres answers "what did it cost".

- **Engine log.** The JSON log on stderr stays the only engine output format. Log level is raised to `info` (`JARVIS_LOG_LEVEL`, default `info`) for lifecycle events only: run started/finished, task stage, permission requested/answered, watcher poll, heartbeat failure. Each line carries a fixed `event` key plus ids (`runId`, `sessionId`, `taskId`). Nothing is logged per stream-json event; those stay in `run_events`. The systemd units send stderr to journald, with no log file and no rotation to manage.
- **Claude Code telemetry.** The CLI exports metrics and logs from its own process, switched on by environment variables on the child (`CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_*`). The engine only builds that environment; it embeds no SDK. Resource attributes carry the role and the run, task and session ids so a metric can be traced to a Postgres row.
- **Alloy.** One agent on the host. It reads the journald units `jarvis-engine` and `jarvis-web`, parses the JSON lines, receives the CLI's OTLP on `127.0.0.1:4318`, and forwards logs and metrics to Grafana Cloud. Config lives in `deploy/alloy/`. Alloy listens on loopback only (ADR-0015).
- **Liveness.** The engine's existing health check (`GET /api/health`) drives a timer every 60 seconds that pings a healthchecks.io URL, and pings its `/fail` address when health is `failed`. The ping is fire-and-forget: a failed request is logged at `warn` and never blocks the tick. Without a `HEARTBEAT_URL` the timer does not start. A silent engine is noticed by healthchecks.io when pings stop, which is the one signal a dead process cannot send itself.
- **Economics.** Cost, tokens, turns and stop reason per session stay in Postgres. They are the source of truth for budgets (`LIM-04`); the admin Usage page reads them. Grafana panels may show the same numbers, but a budget decision never reads Grafana.

Constraints:
- **Off by default.** `jarvis.config.json` gets a `telemetry` block (`enabled`, `otlpEndpoint`, `protocol`) with `enabled: false`. When it is off, a child `claude` receives no `OTEL_*` variable and no `CLAUDE_CODE_ENABLE_TELEMETRY`, not even set to `0`.
- **No prompt text leaves the host.** `OTEL_LOG_USER_PROMPTS=0` is set whenever telemetry is on; it is not configurable.
- **Credentials are secrets.** Grafana Cloud credentials (including `OTEL_EXPORTER_OTLP_HEADERS`) live in `~/.jarvis/.env` or Infisical (ADR-0016), never in `jarvis.config.json`. Alloy's own credentials live in `/etc/jarvis/alloy.env`, `root:alloy`, mode `0640`: the group is Alloy's service user, never `jarvis`, which also runs `claude`. `HEARTBEAT_URL` is handled the same way.
- **No credentials in the child.** A child `claude` never receives `OTEL_EXPORTER_OTLP_HEADERS` or any other Grafana Cloud credential. It exports only to the local Alloy endpoint (`otlpEndpoint`, loopback); Alloy alone authenticates to Grafana Cloud.
- **Allow-list.** Every new child variable is added to the allow-list in `engine/src/infrastructure/claude/child-env.ts` explicitly and tested (ADR-0007). The engine's own secrets stay out of the child.

Not done, and why:
- **No OTel SDK in the engine.** The CLI already exports what is worth having from a run, and the engine's log covers its own lifecycle. This avoids a dependency, and with it an ADR for one.
- **No Sentry.** Errors are `warn`/`error` lines in the same journald stream and a failed run is a `stop_reason` in Postgres; a second service and SDK would duplicate both.
- **No Prometheus on the host.** Alloy forwards metrics straight to Grafana Cloud; a local store is one more process to patch and back up.
- **No public uptime probe.** The tailnet is private and nothing listens on a public interface, so an external checker cannot reach Jarvis. An outbound heartbeat needs no inbound port.

### Consequences
- Good, because `engine/package.json` is unchanged and the engine's only new code is an `info` log level, a heartbeat timer and an environment builder.
- Good, because with `enabled: false` (the laptop and webinar default) nothing leaves the machine and no account is needed.
- Good, because the money question has one answer, in the database that already enforces budgets.
- Bad, because there are three external accounts to keep (Grafana Cloud, healthchecks.io, Infisical) and one more agent to install and update on the host.
- Bad, because Grafana and Postgres can disagree on cost; Postgres wins, and the dashboard says so.
- Bad, because the free tier has volume limits; per-run ids as metric labels can exhaust its series quota, so high-cardinality ids belong on logs, not on metric labels. For one owner the ids stay in the tens per day and the free tier absorbs them; if a quota is ever hit, Alloy drops those labels from metrics, which is a config change, not a new decision.
- Risk: Claude Code's OTel variable names and metric names come from the CLI's "Monitoring usage" documentation and can change between versions. They must be verified against the installed CLI (2.1.318 on the owner's laptop, and again on the server's version) before the dashboard is trusted.

### Confirmation
- RULE: The engine has no `@opentelemetry` dependency.
  CHECK: `grep -c opentelemetry engine/package.json` → `0`
- RULE: `OTEL_*` and `CLAUDE_CODE_ENABLE_TELEMETRY` reach a child only when `telemetry.enabled`, and `OTEL_LOG_USER_PROMPTS` is `0`.
  CHECK: `engine/src/infrastructure/claude/env.test.ts`
- RULE: A child `claude` never receives `OTEL_EXPORTER_OTLP_HEADERS` or any Grafana Cloud credential; there is no pass-through.
  CHECK: `grep -c OTEL_EXPORTER_OTLP_HEADERS engine/src/infrastructure/claude/child-env.ts` → `0`, and `engine/src/infrastructure/claude/env.test.ts` asserts the key is absent from the child env when telemetry is enabled
- RULE: `jarvis.config.example.json` ships `telemetry.enabled: false`, and no Grafana or heartbeat credential is in any committed file.
  CHECK: `grep -n '"enabled": false' jarvis.config.example.json` + `git grep -nE "(glc_|OTEL_EXPORTER_OTLP_HEADERS=.+|hc-ping\.com/[0-9a-f-]{36})"` (expect none)
- RULE: On the server the Alloy credential file is `/etc/jarvis/alloy.env`, `root:alloy`, mode `0640`, and `jarvis` is not in group `alloy`.
  CHECK: `stat -c '%a %U:%G' /etc/jarvis/alloy.env` → `640 root:alloy`, and `id -nG jarvis | grep -wc alloy` → `0`
