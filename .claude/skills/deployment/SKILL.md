---
name: deployment
description: How Jarvis is deployed to the Hetzner VPS (ADR-0016) and the deployment practices behind that setup. Use when touching scripts/deploy.sh, deploy/systemd/*, docs/architecture/deployment.md, or compose.yaml's server profile; when adding a new service or route that needs to be deployed; or when asked how to deploy, roll back, or redesign the deploy flow.
---

# Deployment

Jarvis runs on a single Hetzner VPS as systemd services, reached only over Tailscale (ADR-0016), with secrets
from Infisical (ADR-0015). Production is bare systemd — not Docker — because the engine has to run the host's
own Node/pnpm toolchain to work on the target repository. Docker is used only for Postgres on the server, and
separately for a laptop-only rehearsal container (ADR-0016) that is never the deploy target.

The full setup is `docs/architecture/deployment.md`; the files are listed in `deploy/README.md`. This skill is
about how to *change* the deploy flow without breaking the properties it currently holds.

## Current flow

`pnpm run redeploy` from the laptop (`scripts/redeploy.sh`) is the manual entry point: it previews the commits,
waits for live runs to finish (`-- --now` skips that), runs the deploy and verifies health. Underneath it,
`pnpm run deploy:remote` (`ssh root@jarvis-01 /home/jarvis/jarvis/scripts/deploy.sh`) runs
`scripts/deploy.sh` as root, which does every git and pnpm step as `jarvis` through `runuser` and only `systemctl` /
`systemd-run` as root. `jarvis` has no sudo rule, so `pnpm run deploy` as `jarvis` on the server only works once one
exists. The script body is a single function, so step 1 rewriting the script mid-run is safe:

1. `git fetch` + `git merge --ff-only origin/main` — refuses to run if the local checkout has diverged, instead
   of silently rewriting it.
2. `pnpm install --frozen-lockfile` — resolve dependencies for the commit that's about to run, before anything
   is restarted.
3. `pnpm --filter @jarvis/web build` — fail here, not after the engine has already been bounced.
4. `scripts/with-secrets.sh pnpm --filter @jarvis/engine db:migrate` — runs against the *old* engine, which is
   still serving traffic.
5. `systemctl restart jarvis-engine` — `deploy/systemd/jarvis-engine.service`'s `ExecStartPost` calls
   `GET /api/health` and fails the unit if the new engine doesn't come up healthy.
6. `systemctl restart jarvis-web` — only if that unit is installed; it isn't yet (the public UI is on hold).

A `flock` around the whole script stops two deploys from overlapping.

Always invoke it as `pnpm run deploy`, never the bare `pnpm deploy` — that bare form is pnpm's own built-in
`deploy` subcommand (for packaging a workspace project for publishing), unrelated to this repo's script.

## Practices this flow already follows

- **Backward-compatible migrations before the restart.** Step 4 runs before step 5 on purpose: the old code
  must keep working against the new schema for the gap between them. Any new migration has to be additive
  (expand/contract), matching ADR-0008 — never a rename or drop that the currently-running engine can't survive.
- **Health-gate the restart, not just the deploy.** `ExecStartPost` in the systemd unit is what actually
  enforces this, not the script — a new unit for a new service should carry the same kind of gate
  (`ExecStartPost` hitting its own health route, or an equivalent check) rather than relying on the deploy
  script alone.
- **State lives outside the deployed artifact.** Postgres' volume, `~/.jarvis`, `~/.claude`, and Infisical hold
  everything that must survive a redeploy. The checkout itself is disposable and gets overwritten by `git pull`
  every run.
- **One secret path.** `scripts/with-secrets.sh` is the only place secrets enter a process's environment
  (Infisical in prod, `~/.jarvis/.env` as the laptop fallback). A new service should run through it too, not
  grow its own secret-loading logic.
- **Single-writer deploys.** The `flock` in `scripts/deploy.sh` is the whole mechanism; there is no CI runner
  and no webhook triggering it. Deploys are a deliberate, manual, SSH-over-Tailscale action.

## Practices to add before this grows past "one script, one box"

These are not implemented — they're what to reach for first if the deploy flow gets more complex (more
services, more environments, a public-facing component, or a rewrite of a piece of the stack):

- **Build-then-swap, not live-patch.** `git pull` currently rewrites the checkout that the running process was
  started from. That's fine for one box with one deploy at a time, but it stops being fine the moment a build
  can fail halfway: the next step is building into a fresh `releases/<sha>` directory (or a container image) and
  only swapping a `current` symlink (or restarting against the new image) once the build and health check both
  pass. This also gives a real rollback: point `current` back at the previous release and restart.
- **Versioned releases, not "whatever is on `main` right now".** Tagging what actually went out (a release tag,
  or at minimum logging the deployed SHA somewhere durable) makes "what's running in prod" an answerable
  question without SSHing in, and makes rollback a known-good target instead of a guess.
- **An explicit rollback path**, tested before it's needed: keep the previous release's dependencies and build
  output around (don't `rm` them on install), so reverting is "point at the old release and restart", not
  "re-clone and rebuild an old commit under pressure".
- **Health-gate every service that gets added**, the same way `jarvis-engine.service` gates on `/api/health` —
  a service with no startup health check is a service that can "succeed" at restarting into a broken state.
- **Treat a public-facing surface as a bigger decision than an internal one.** `jarvis-web` is deliberately not
  enabled yet because exposing a UI that controls the agent changes the deploy's blast radius (who can reach it,
  what auth it needs, what `tailscale serve` or a reverse proxy should gate). Don't flip that on as a side effect
  of a deploy script change — it's a decision with its own ADR, not a line in `scripts/deploy.sh`.
- **Automate the trigger only after the manual flow is trusted.** A GitHub Actions workflow (e.g. via
  `tailscale/github-action`) that calls `pnpm run deploy` over the tailnet on push to `main` is a reasonable next
  step, but it adds a new trust boundary (a CI runner with a key into the tailnet, secrets in GitHub Actions
  config) that the current manual, SSH-triggered flow deliberately avoids. Add it deliberately, not by default.
