---
status: accepted
date: 2026-11-08
decision-makers: ["Ivan Lapa"]  # owner accepted 2026-11-08; drafted by Claude
scope: ["compose.yaml", "docker/runtime/**", "README.md", "docs/architecture/deployment.md"]
supersedes: []
superseded-by: []
---

# ADR-0017: Rehearse the server setup in a Linux runtime image on the laptop; production stays bare systemd

## Context and Problem Statement
ADR-0015 puts Jarvis on a Hetzner VPS as systemd services under a non-root `jarvis` user. Nothing in that
setup has been run yet, and the laptop differs from the server in ways that decide whether Jarvis starts:

- macOS keeps the Claude Code subscription login in the Keychain; Linux keeps it in
  `~/.claude/.credentials.json` (mode 600). On a headless box the login is `claude`, then `/login`, with a
  code pasted back. The owner has never done this, so it must be tried before the VPS exists.
- The server runs as the non-root user `jarvis` (uid 1000) and logs to journald. The laptop has neither.
- On the owner's laptop the `claude` on `PATH` is a managed wrapper, not the official binary, and it needs
  about 20 seconds per invocation, longer than the engine's 8-second connection-probe timeout, so
  `engine.claudeBinary` has to point at the genuine installed binary. Inside a Linux image the official
  installer gives a plain, fast `claude`, so the image is closer to the server than the laptop host is.

The question is how to find these problems without paying for, and debugging on, the real server.

## Considered Options
- Rehearse in a container on the laptop: a Linux runtime image built from the repository, run through a `server` profile in `compose.yaml`
- Rehearse on a throwaway Hetzner box
- Do not rehearse; go straight to the VPS

## Decision Outcome
Chosen option: "container on the laptop", because it costs nothing, can be rebuilt in minutes, and
exercises the parts that differ between laptop and server (Linux filesystem, non-root user, Node and pnpm
from a clean install, the `claude` login layout) before the owner depends on them. It is a rehearsal, not
a deployment target: production stays bare systemd on the VPS and ADR-0015 is unchanged.

- **Image.** `docker/runtime`: Ubuntu LTS, Node and pnpm via corepack, `git`, `gh`, Claude Code from the official installer, user `jarvis` (uid 1000) with `HOME=/home/jarvis`. No Docker CLI; Postgres is a sibling service.
- **Compose.** `compose.yaml` gains services `engine` and `web` under `profiles: [server]`, built from `docker/runtime`, running the same `pnpm` scripts as the host and depending on the existing `postgres` service. Without `--profile server` nothing changes for the laptop workflow.
- **Ports.** Only `127.0.0.1` ports are published. Inside the container the processes may bind all interfaces, because the host mapping is the boundary.
- **State outside the image.** The checkout, `~/.jarvis` and `~/.claude` are volumes, so rebuilding the image never loses the login or the config.
- **Dependencies.** The Linux `node_modules` of every workspace is a Docker volume, never the host's directory, because a bind-mounted macOS install cannot execute under Linux. The entrypoint runs `pnpm install --frozen-lockfile` on every start.
- **Login.** `claude` then `/login` is run once in the container; the credentials file lands in the `~/.claude` volume.
- **Not covered.** systemd itself (units, restart policy, `ExecStartPost`), journald, Tailscale, the firewall, the Hetzner kernel and Docker-in-Docker. The rehearsal covers the Linux filesystem, the user, Node/pnpm and the `claude` login layout only. `docs/architecture/deployment.md` and the README say so.

### Consequences
- Good, because the headless `/login`, the file mode of `.credentials.json` and a clean `pnpm install` on Linux are tried before the server is rented.
- Good, because the `claude` in the image is not the corporate wrapper, so the connection probe behaves as it will on the server.
- Good, because ADR-0015 and the bare-systemd production path stay as decided; the image adds no second deployment to maintain.
- Bad, because a green rehearsal can give false confidence: units, journald and Tailscale are untested until the VPS exists.
- Bad, because Docker Desktop on this laptop runs under a corporate sign-in policy: containers run only while the owner is signed in. The rehearsal works on demand, not as an always-on service, and must not be mistaken for the server.
- Bad, because the container listens on all interfaces internally, which is looser than ADR-0015's loopback rule on a host; the published `127.0.0.1` mapping and the rule below hold that line. This ADR is a documented exception to ADR-0015's "engine, web and Postgres listen on 127.0.0.1" rule: inside a container the processes may bind all interfaces, and the published `127.0.0.1` mapping is where that rule is enforced.

### Confirmation
- RULE: compose profile server publishes only 127.0.0.1 ports.
  CHECK: `docker compose --profile server config | grep -E "published|host_ip"` — every published port must show `host_ip: 127.0.0.1`.
  Quick eyeball check: `grep -n "127.0.0.1" compose.yaml` (it does not distinguish the profile's ports from Postgres's).
- RULE: The runtime image runs as `jarvis` (uid 1000), not root, and contains no `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`.
  CHECK: `docker compose --profile server run --rm engine id -u` prints `1000`; engine start-up guard (ADR-0004)
