#!/usr/bin/env bash
# Deploy Jarvis on the Hetzner VPS (ADR-0015), following the sequence documented in
# docs/architecture/deployment.md §5 "Update". Run as `jarvis` from ~/jarvis:
#   ~/jarvis/scripts/deploy.sh
#
# What it does, in order, and why that order:
#   1. git pull            - take the commit that's about to run.
#   2. pnpm install         - resolve node_modules for that commit before anything restarts.
#   3. build web            - fail here, not after the engine is already bounced.
#   4. db:migrate            - runs against the OLD engine still serving traffic; Drizzle
#                             migrations in this repo are additive/backward-compatible
#                             (ADR-0010), so the old code keeps working against the new schema.
#   5. restart jarvis-engine - systemd's ExecStartPost hits /api/health and fails the unit
#                             if the new engine doesn't come up healthy (deploy/systemd/jarvis-engine.service).
#   6. restart jarvis-web    - only after the engine is confirmed healthy.
#
# jarvis-web is intentionally not enabled yet (public-UI access is still undecided), so step 6
# is a no-op until that unit exists and is enabled; the script does not fail if it's absent.
#
# A lock file stops two deploys from overlapping (e.g. a second SSH session running this by hand
# while the first is mid-migration).
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/jarvis}"
LOCK_FILE="/tmp/jarvis-deploy.lock"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "deploy: another deploy is already running (lock: $LOCK_FILE)" >&2
  exit 1
fi

cd "$REPO_DIR"

before_rev="$(git rev-parse HEAD)"
echo "deploy: at $before_rev, pulling main..."
git fetch origin main
git merge --ff-only origin/main
after_rev="$(git rev-parse HEAD)"

if [ "$before_rev" = "$after_rev" ]; then
  echo "deploy: already up to date at $after_rev"
else
  echo "deploy: $before_rev -> $after_rev"
fi

echo "deploy: installing dependencies..."
pnpm install --frozen-lockfile

echo "deploy: building web..."
pnpm --filter @jarvis/web build

echo "deploy: running migrations..."
scripts/with-secrets.sh pnpm --filter @jarvis/engine db:migrate

echo "deploy: restarting jarvis-engine..."
sudo systemctl restart jarvis-engine
sudo systemctl --no-pager status jarvis-engine | head -5

if systemctl list-unit-files jarvis-web.service >/dev/null 2>&1; then
  echo "deploy: restarting jarvis-web..."
  sudo systemctl restart jarvis-web
else
  echo "deploy: jarvis-web.service not installed yet, skipping (public UI is on hold)"
fi

echo "deploy: done, now at $(git rev-parse --short HEAD)"
