#!/usr/bin/env bash
# systemd ExecStartPost gate for jarvis-engine (ADR-0016): wait until the engine answers /api/health.
# 200 (ok, degraded) and 503 (alive, but the database is down) both mean the process is up and honest;
# only "no answer" or another code fails the start. Treating 503 as failure made systemd kill a live
# engine every ~68 s while Postgres was still starting (server-readiness review, Important 3).
# The deadline keeps the worst case (60 s + one 5 s request) inside the unit's TimeoutStartSec=90.
set -uo pipefail

url="${1:-http://127.0.0.1:4310/api/health}"
deadline=$((SECONDS + 60))
code=000

while [ "$SECONDS" -lt "$deadline" ]; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url")"
  case "$code" in
    200) exit 0 ;;
    503)
      echo "wait-healthy: engine is up, database is not (503)" >&2
      exit 0
      ;;
  esac
  sleep 1
done

echo "wait-healthy: no healthy answer from $url within 60 s (last status $code)" >&2
exit 1
