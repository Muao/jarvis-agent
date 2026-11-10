#!/usr/bin/env bash
# Deploy Jarvis on the Hetzner VPS (ADR-0016), following the sequence documented in
# docs/architecture/deployment.md §5 "Update". Run it either way:
#   ssh root@<host> /home/jarvis/jarvis/scripts/deploy.sh   # from the laptop, over Tailscale SSH
#   ~/jarvis/scripts/deploy.sh                              # as jarvis, only with a sudo rule for systemctl
# `jarvis` has no password and no sudo rule, so the root form is the one that works today. As root,
# every step that touches the checkout (git, pnpm) runs as `jarvis` through runuser, so the checkout,
# node_modules and the pnpm store never end up owned by root; only systemctl and systemd-run run as root.
#
# What it does, in order, and why that order:
#   1. git pull            - take the commit that's about to run.
#   2. pnpm install         - resolve node_modules for that commit before anything restarts.
#   3. build web            - fail here, not after the engine is already bounced.
#   4. db:migrate            - runs against the OLD engine still serving traffic; Drizzle
#                             migrations in this repo are additive/backward-compatible
#                             (ADR-0008), so the old code keeps working against the new schema.
#   5. restart jarvis-engine - systemd's ExecStartPost hits /api/health and fails the unit
#                             if the new engine doesn't come up healthy (deploy/systemd/jarvis-engine.service).
#   6. restart jarvis-web    - only after the engine is confirmed healthy.
#
# jarvis-web is intentionally not enabled yet (public-UI access is still undecided), so step 6
# is a no-op until that unit exists and is enabled; the script does not fail if it's absent.
#
# It never calls Docker: Postgres and its `pgdata` volume are left alone, so a redeploy keeps every row.
#
# A lock file stops two deploys from overlapping (e.g. a second SSH session running this by hand
# while the first is mid-migration).
set -euo pipefail

# The whole body is one function, read in full before it starts: step 1 can rewrite this very file,
# and bash otherwise reads a script line by line as it runs.
main() {
  DEPLOY_USER="${DEPLOY_USER:-jarvis}"
  if [ "$(id -u)" -eq 0 ]; then
    AS_USER="runuser -u $DEPLOY_USER --"
    SUDO=""
    REPO_DIR="${REPO_DIR:-/home/$DEPLOY_USER/jarvis}"
  else
    AS_USER=""
    SUDO="sudo"
    REPO_DIR="${REPO_DIR:-$HOME/jarvis}"
  fi
  LOCK_FILE="/tmp/jarvis-deploy.lock"

  # Opened read-only: /tmp is sticky, and fs.protected_regular forbids opening another user's file there
  # for writing, so a lock left by a root deploy would otherwise break the next deploy run as jarvis.
  [ -e "$LOCK_FILE" ] || : >"$LOCK_FILE"
  exec 9<"$LOCK_FILE"
  if ! flock -n 9; then
    echo "deploy: another deploy is already running (lock: $LOCK_FILE)" >&2
    exit 1
  fi

  cd "$REPO_DIR"

  before_rev="$($AS_USER git rev-parse HEAD)"
  echo "deploy: at $before_rev, pulling main..."
  $AS_USER git fetch origin main
  $AS_USER git merge --ff-only origin/main
  after_rev="$($AS_USER git rev-parse HEAD)"

  if [ "$before_rev" = "$after_rev" ]; then
    echo "deploy: already up to date at $after_rev"
  else
    echo "deploy: $before_rev -> $after_rev"
  fi

  echo "deploy: installing dependencies..."
  $AS_USER pnpm install --frozen-lockfile

  echo "deploy: building web..."
  $AS_USER pnpm --filter @jarvis/web build

  echo "deploy: running migrations..."
  # On the server the Infisical machine identity lives in /etc/jarvis/infisical.env (root:root 0600, so a
  # child `claude` running as jarvis cannot read it). The migration runs as jarvis, so it borrows the engine
  # unit's view of that file through a transient unit instead of reading it itself. Without the file
  # (laptop rehearsal) it runs as before, with ~/.jarvis/.env as the fallback.
  INFISICAL_ENV_FILE="${INFISICAL_ENV_FILE:-/etc/jarvis/infisical.env}"
  if [ -e "$INFISICAL_ENV_FILE" ]; then
    $SUDO systemd-run --quiet --wait --pipe --collect --uid=jarvis --same-dir \
      -p EnvironmentFile="$INFISICAL_ENV_FILE" \
      "$REPO_DIR/scripts/with-secrets.sh" pnpm --filter @jarvis/engine db:migrate
  else
    $AS_USER scripts/with-secrets.sh pnpm --filter @jarvis/engine db:migrate
  fi

  echo "deploy: restarting jarvis-engine..."
  $SUDO systemctl restart jarvis-engine
  $SUDO systemctl --no-pager status jarvis-engine | head -5

  if systemctl list-unit-files jarvis-web.service >/dev/null 2>&1; then
    echo "deploy: restarting jarvis-web..."
    $SUDO systemctl restart jarvis-web
  else
    echo "deploy: jarvis-web.service not installed yet, skipping (public UI is on hold)"
  fi

  echo "deploy: done, now at $($AS_USER git rev-parse --short HEAD)"
}

main "$@"
exit
