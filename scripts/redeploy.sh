#!/usr/bin/env bash
# Redeploy Jarvis by hand, from the laptop, in one command:
#
#   pnpm run redeploy            # wait for live runs to finish (up to 10 min), deploy, verify
#   pnpm run redeploy -- --now   # do not wait: a live run is interrupted and resumed after the restart
#   pnpm run redeploy -- --wait 30   # wait up to 30 minutes instead of 10
#   pnpm run redeploy -- --check     # only show what would be deployed and whether a run is live
#
# It wraps scripts/deploy.sh (which does the pull, install, build, migrate and restart on the server)
# with the three things one otherwise does by hand around it: look at what is about to go out, avoid
# cutting a working agent off mid-turn, and check that the engine came back healthy.
#
# Environment: JARVIS_HOST (default root@jarvis-01), JARVIS_ENGINE_PORT (default 4310).
set -euo pipefail

HOST="${JARVIS_HOST:-root@jarvis-01}"
PORT="${JARVIS_ENGINE_PORT:-4310}"
REPO_DIR="/home/jarvis/jarvis"
WAIT_MINUTES=10
NOW=0
CHECK_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --now) NOW=1 ;;
    --check) CHECK_ONLY=1 ;;
    --wait)
      shift
      WAIT_MINUTES="${1:?--wait needs a number of minutes}"
      ;;
    -h | --help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "redeploy: unknown argument: $1 (see --help)" >&2
      exit 2
      ;;
  esac
  shift
done
case "$WAIT_MINUTES" in
  '' | *[!0-9]*)
    echo "redeploy: --wait takes whole minutes, got: $WAIT_MINUTES" >&2
    exit 2
    ;;
esac

remote() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" "$@"; }

# Live runs, one per line as "role task started"; empty when the engine is idle.
live_runs() {
  remote 'c=$(docker ps --format "{{.Names}}" | grep -m1 postgres) && docker exec "$c" psql -U jarvis -At -F " " -c "select role, coalesce(task_id, '"'"'-'"'"'), to_char(started_at, '"'"'HH24:MI'"'"') from runs where status = '"'"'running'"'"'"'
}

echo "redeploy: $HOST"
remote "cd $REPO_DIR && runuser -u jarvis -- git fetch -q origin main && echo \"  running: \$(runuser -u jarvis -- git log -1 --format='%h %s')\" && n=\$(runuser -u jarvis -- git rev-list --count HEAD..origin/main) && if [ \"\$n\" = 0 ]; then echo '  nothing new on main: this restarts the same commit'; else echo \"  to deploy (\$n):\"; runuser -u jarvis -- git log --format='    %h %s' HEAD..origin/main; fi"

runs="$(live_runs)"
if [ -n "$runs" ]; then
  echo "redeploy: live runs (role task started-UTC):"
  echo "$runs" | sed 's/^/  /'
fi

if [ "$CHECK_ONLY" = 1 ]; then
  [ -n "$runs" ] || echo "redeploy: no live runs"
  exit 0
fi

if [ -n "$runs" ] && [ "$NOW" = 0 ]; then
  echo "redeploy: waiting up to $WAIT_MINUTES min for them to finish (--now skips this)..."
  deadline=$(($(date +%s) + WAIT_MINUTES * 60))
  while [ -n "$runs" ]; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "redeploy: still running after $WAIT_MINUTES min; nothing was deployed. Run again, or use --now." >&2
      exit 1
    fi
    sleep 15
    runs="$(live_runs)"
  done
  echo "redeploy: idle"
elif [ -n "$runs" ]; then
  echo "redeploy: --now: these runs are interrupted and resumed after the restart"
fi

remote "$REPO_DIR/scripts/deploy.sh"

# The engine unit already refuses to start unhealthy (ExecStartPost); this is the view from outside it.
echo "redeploy: verifying..."
remote "code=\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/api/health || true); echo \"  health: \$code\"; echo \"  engine: \$(systemctl is-active jarvis-engine)\"; if systemctl list-unit-files jarvis-web.service >/dev/null 2>&1; then echo \"  web:    \$(systemctl is-active jarvis-web)\"; fi; echo \"  commit: \$(cd $REPO_DIR && runuser -u jarvis -- git log -1 --format='%h %s')\"; [ \"\$code\" = 200 ] && [ \"\$(systemctl is-active jarvis-engine)\" = active ]" || {
  echo "redeploy: the engine is not healthy. Logs: ssh $HOST journalctl -u jarvis-engine -n 80 --no-pager" >&2
  exit 1
}
echo "redeploy: done"
