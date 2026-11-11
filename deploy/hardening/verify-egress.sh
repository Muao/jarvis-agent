#!/usr/bin/env bash
# Verify the H2 egress filter from a throwaway rootless container. Run on the server as root:
#   sudo deploy/hardening/verify-egress.sh
# JARVIS_TAILNET_NAME: the host's own tailnet HTTPS name (e.g. from `tailscale status`); required.
# Blocked targets must FAIL, public targets must SUCCEED. Exits non-zero on any wrong result.
set -uo pipefail

RUN_AS="${EGRESS_USER:-jarvis}"
NAME="${JARVIS_TAILNET_NAME:?set JARVIS_TAILNET_NAME to this host's tailnet name (see tailscale status)}"
PORT="${JARVIS_ENGINE_PORT:-4310}"
uid="$(id -u "$RUN_AS")"
fail=0

as_jarvis() { runuser -u "$RUN_AS" -- env XDG_RUNTIME_DIR="/run/user/$uid" DOCKER_HOST="unix:///run/user/$uid/docker.sock" "$@"; }
in_container() { as_jarvis docker run --rm --pull=missing curlimages/curl:8.11.1 "$@"; }

expect_fail() {
  if in_container -sS -o /dev/null --max-time 6 "$2" >/dev/null 2>&1; then
    echo "FAIL  $1 is reachable from a container ($2)"
    fail=1
  else
    echo "ok    blocked: $1"
  fi
}
expect_ok() {
  if in_container -sS -o /dev/null --max-time 20 "$2" >/dev/null 2>&1; then
    echo "ok    reachable: $1"
  else
    echo "FAIL  $1 is not reachable ($2)"
    fail=1
  fi
}

expect_fail "host tailnet HTTPS name" "https://$NAME/api/health"
expect_fail "MagicDNS resolver" "http://100.100.100.100/"
expect_fail "cloud metadata" "http://169.254.169.254/"
expect_ok "npm registry" "https://registry.npmjs.org/"

if as_jarvis docker pull -q node:22-bookworm >/dev/null 2>&1; then
  echo "ok    docker pull node:22-bookworm"
else
  echo "FAIL  docker pull node:22-bookworm"
  fail=1
fi

if [ "$(as_jarvis docker run --rm curlimages/curl:8.11.1 sh -c 'cat /etc/resolv.conf' | grep -ci 'ts.net\|100.100.100.100')" = 0 ]; then
  echo "ok    container resolv.conf has no tailnet name/MagicDNS"
else
  echo "FAIL  container resolv.conf leaks the tailnet"
  fail=1
fi

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/api/health" || true)"
if [ "$code" = 200 ]; then echo "ok    engine health 200"; else
  echo "FAIL  engine health $code"
  fail=1
fi

# The engine's own needs, as uid jarvis on the host: DNS and public HTTPS must keep working.
for h in github.com registry.npmjs.org; do
  if as_jarvis getent hosts "$h" >/dev/null 2>&1; then echo "ok    jarvis resolves $h"; else
    echo "FAIL  jarvis cannot resolve $h (check /etc/resolv.conf, resolvectl status)"
    fail=1
  fi
done
if as_jarvis curl -sS -o /dev/null --max-time 15 https://api.github.com >/dev/null 2>&1; then
  echo "ok    jarvis reaches api.github.com"
else
  echo "FAIL  jarvis cannot reach api.github.com"
  fail=1
fi

# The filter matches the uid, not the host: jarvis itself (the engine, worker Bash) is blocked too.
if as_jarvis curl -s -o /dev/null --max-time 6 "https://$NAME/api/health" >/dev/null 2>&1; then
  echo "FAIL  uid $RUN_AS on the host reaches the tailnet name"
  fail=1
else
  echo "ok    blocked for uid $RUN_AS on the host"
fi

[ "$fail" = 0 ] && echo "egress verification passed" || echo "egress verification FAILED"
exit "$fail"
