---
status: superseded
date: 2026-11-02
decision-makers: []  # owner chose Hetzner VPS + Tailscale 2026-11-02; drafted by Claude
scope: ["compose.yaml", "web/vite.config.ts", "docs/architecture/deployment.md"]
supersedes: []
superseded-by: ["0025"]
---

# ADR-0015: Run Jarvis on a Hetzner VPS as systemd services, reached only over Tailscale

## Context and Problem Statement
Jarvis is built for the owner's laptop, but a laptop sleeps, travels and closes its lid while a task
waits for CI. The owner wants Jarvis on a server that is always on, where they log in to `claude` once
with their own subscription (ADR-0004: no API key). The engine and web app have no login and listen on
loopback only, so they must never be reachable from the public internet.

## Considered Options
- Hetzner Cloud VPS (Linux, 8–16 GB RAM) with Node, pnpm, Docker and `claude` installed on the host; engine and web as systemd services; access over Tailscale
- The same, with engine and web in Docker containers
- A home Mac mini
- Add a login to the web app and expose it on a public domain

## Decision Outcome
Chosen option: "Hetzner VPS, host install, Tailscale", because it is the cheapest always-on machine, it
runs exactly what the laptop runs (same `pnpm` scripts, same `~/.jarvis` home from ADR-0011), and
Tailscale gives the owner's laptop and phone a private HTTPS address without opening a single port.

- **Host.** Ubuntu LTS, a non-root `jarvis` user that owns `~/.jarvis`, `~/.claude` and the checkout. Docker only for Postgres (`compose.yaml` as is). Worker runs need the target repo's toolchain on the host, which is why engine and web are not containerised.
- **Claude.** The owner runs `claude` as `jarvis` over SSH and completes `/login` with the subscription; credentials stay in that user's `~/.claude`. The engine's start-up guard (ADR-0004) is unchanged.
- **Processes.** `jarvis-engine.service` runs `pnpm --filter @jarvis/engine start`; `jarvis-web.service` serves the built SPA with `vite preview` on `127.0.0.1:5180`, which proxies `/api` to the engine as in dev. Both restart on failure and start on boot.
- **Network.** The VPS firewall allows nothing inbound except SSH (later only over Tailscale). `tailscale serve --bg 5180` publishes the web app as `https://<host>.<tailnet>.ts.net` to the owner's tailnet only. Vite must accept that host name (`preview.allowedHosts`).
- **Deploy.** Iteration 1: `git pull && pnpm install && pnpm --filter @jarvis/web build && pnpm --filter @jarvis/engine db:migrate && systemctl restart` over SSH. A GitHub Actions deploy over Tailscale can follow once this is stable.

### Consequences
- Good, because the PoC stays one machine, one user, no containers to keep in sync with the laptop setup.
- Good, because nothing is exposed publicly; losing the tailnet means losing access, not leaking it.
- Bad, because the host carries state (Postgres volume, `~/.jarvis`, `~/.claude`); it needs backups (Hetzner snapshots) and a rebuild runbook.
- Bad, because the subscription login lives on a server; anyone with SSH as `jarvis` can use it, so SSH is key-only and the tailnet has only the owner's devices.

### Confirmation
- RULE: No Jarvis port is bound to a public interface; engine, web and Postgres listen on `127.0.0.1`.
  CHECK: `ss -tlnp` on the server + `grep -n "127.0.0.1" compose.yaml web/vite.config.ts`
- RULE: The server has no `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` in any environment.
  CHECK: engine start-up guard (ADR-0004)
