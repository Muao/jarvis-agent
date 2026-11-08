---
status: accepted
date: 2026-11-08
decision-makers: ["Ivan Lapa"]  # consolidation of the former 0015/0017/0018 (pre-renumbering) (owner-accepted individually 2026-11-02…08); merged 2026-11-08 on the owner's "consolidate the ADRs"
scope: ["compose.yaml", "docker/runtime/**", "deploy/**", "web/vite.config.ts", "engine/src/infrastructure/claude/**", "engine/src/infrastructure/logging/**", "engine/src/presentation/timers/**", "shared/src/config.ts", "docs/architecture/deployment.md"]
supersedes: []  # consolidates the former 0015, 0017 and 0018 (pre-renumbering; see git history)
superseded-by: []
---

# ADR-0016: Server operations — a Hetzner VPS behind Tailscale, rehearsed in a local runtime image, observed through journald + the CLI's OTel + Grafana Cloud

One record for how Jarvis runs unattended. It consolidates the former records 0015 (placement),
0017 (rehearsal) and 0018 (telemetry) without changing any of their decisions; the originals' full
option analyses live in git history.

## Context and Problem Statement

A laptop sleeps mid-task; the owner wants Jarvis always on, logged into `claude` with their own
subscription (ADR-0003), with no public exposure, and needs to know — without SSH — whether Jarvis is
alive and what each session cost. None of the server setup can be debugged for the first time on a paid
box.

## Decision Outcome

### 1. Placement: Hetzner VPS, host install, systemd, Tailscale only (formerly 0015)

- Ubuntu LTS, a non-root `jarvis` user owning `~/.jarvis`, `~/.claude` and the checkout. Docker only
  for Postgres. Engine and web run on the host (worker runs need the target repo's toolchain), as
  `jarvis-engine.service` (`pnpm --filter @jarvis/engine start`) and `jarvis-web.service`
  (`vite preview` on `127.0.0.1:5180`, proxying `/api`), restart-on-failure, start-on-boot.
- The owner logs into `claude` as `jarvis` over SSH once; credentials stay in that user's `~/.claude`.
  The ADR-0003 start-up guard is unchanged.
- Nothing listens publicly: the firewall allows only SSH; `tailscale serve --bg 5180` publishes the web
  app to the owner's tailnet only (`preview.allowedHosts` carries the ts.net name).
- Deploy: `scripts/deploy.sh` over SSH (git ff-only pull, install, build, migrate, restart); CI deploy
  can follow once stable.

### 2. Rehearsal: a Linux runtime image on the laptop; production stays bare systemd (formerly 0017)

- `docker/runtime`: Ubuntu LTS, Node + pnpm via corepack, `git`, `gh`, Claude Code from the official
  installer, user `jarvis` (uid 1000). `compose.yaml` services `engine` and `web` under
  `profiles: [server]`; without the profile the laptop workflow is unchanged.
- The checkout, `~/.jarvis`, `~/.claude` and every workspace's Linux `node_modules` are volumes;
  `claude` + `/login` is run once in the container.
- Only `127.0.0.1` ports are published; inside the container processes may bind all interfaces — the
  published loopback mapping is where the rule from §1 is enforced (documented exception).
- Not covered by the rehearsal: systemd itself, journald, Tailscale, the firewall. A green rehearsal
  proves the Linux filesystem, the user, Node/pnpm and the `claude` login layout, nothing more.

### 3. Observability: journald + CLI OTel + one Alloy agent + Grafana Cloud; economics in Postgres (formerly 0018)

- The engine's JSON log on stderr (level `info`, lifecycle events with fixed `event` keys and
  `runId`/`sessionId`/`taskId`) goes to journald via the units; no log files, no engine OTel SDK.
- A child `claude` exports its own OTel metrics/logs when `telemetry.enabled` (default **false**); the
  engine only builds the environment. `OTEL_LOG_USER_PROMPTS=0` always; the child exports to the local
  Alloy on loopback and never receives `OTEL_EXPORTER_OTLP_HEADERS` or any Grafana credential.
- One Grafana Alloy agent on the host reads the `jarvis-engine`/`jarvis-web` journald units, receives
  the CLI's OTLP on `127.0.0.1:4318`, forwards to Grafana Cloud. Its credential lives in
  `/etc/jarvis/alloy.env`, `root:alloy`, `0640`; `jarvis` is not in group `alloy`.
- Liveness: a 60-second timer pings `HEARTBEAT_URL` (healthchecks.io) from the engine's health check,
  `/fail` on failed health, fire-and-forget; no `HEARTBEAT_URL` → no timer. Silence is the signal a
  dead process cannot fake.
- Session economics (cost, tokens, turns, stop reason) stay in Postgres (ADR-0008); budgets (LIM-04)
  and the Usage page read Postgres, never Grafana.

## Consequences

- Good, because the PoC stays one machine and one user; losing the tailnet loses access, not data; with
  telemetry off (the laptop default) nothing leaves the machine.
- Good, because the headless `/login`, `.credentials.json` mode and a clean Linux `pnpm install` are
  tried in a free container before the server depends on them.
- Bad, because the host carries state (Postgres volume, `~/.jarvis`, `~/.claude`) and needs Hetzner
  snapshots plus a rebuild runbook; the subscription login lives on the server, so SSH is key-only and
  the tailnet holds only the owner's devices.
- Bad, because a green rehearsal can give false confidence (units, journald, Tailscale untested until
  the VPS exists), and the laptop's Docker Desktop runs only while the owner is signed in.
- Bad, because three external accounts (Grafana Cloud, healthchecks.io, Infisical) and one more host
  agent; Grafana and Postgres can disagree on cost — Postgres wins.
- Risk: Claude Code's OTel variable and metric names can change between CLI versions; verify against
  the installed CLI before trusting the dashboard.

## Confirmation

- RULE: No Jarvis port binds a public interface; engine, web and Postgres listen on `127.0.0.1`
  (host) and the compose `server` profile publishes only `127.0.0.1` ports.
  CHECK: `ss -tlnp` on the server; `docker compose --profile server config | grep -E "published|host_ip"`
- RULE: The runtime image runs as `jarvis` (uid 1000), not root; no `ANTHROPIC_API_KEY` anywhere.
  CHECK: `docker compose --profile server run --rm engine id -u` → `1000`; ADR-0003 start-up guard
- RULE: The engine has no `@opentelemetry` dependency; `OTEL_*` reaches a child only when
  `telemetry.enabled`, with `OTEL_LOG_USER_PROMPTS=0`, and never `OTEL_EXPORTER_OTLP_HEADERS`.
  CHECK: `grep -c opentelemetry engine/package.json` → `0`; `engine/src/infrastructure/claude/env.test.ts`
- RULE: `jarvis.config.example.json` ships `telemetry.enabled: false`; no Grafana or heartbeat
  credential in any committed file; on the server `/etc/jarvis/alloy.env` is `root:alloy` `0640` and
  `jarvis` is not in group `alloy`.
  CHECK: `grep -n '"enabled": false' jarvis.config.example.json`;
  `git grep -nE "(glc_|hc-ping\.com/[0-9a-f-]{36})"` (expect none);
  `stat -c '%a %U:%G' /etc/jarvis/alloy.env` → `640 root:alloy`; `id -nG jarvis | grep -wc alloy` → `0`
