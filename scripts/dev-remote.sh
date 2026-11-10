#!/usr/bin/env bash
# Local UI (vite dev, hot reload) against the Jarvis engine on the server, over the tailnet.
# Reads JARVIS_API_URL from web/.env.remote (copy web/.env.remote.example). Run: pnpm dev:remote
set -euo pipefail
cd "$(dirname "$0")/.."

env_file=web/.env.remote
if [ ! -f "$env_file" ]; then
  echo "dev-remote: $env_file is missing; copy web/.env.remote.example and set JARVIS_API_URL" >&2
  exit 1
fi
url="$(grep -E '^JARVIS_API_URL=' "$env_file" | tail -1 | cut -d= -f2-)"
if [ -z "$url" ]; then
  echo "dev-remote: JARVIS_API_URL is empty in $env_file" >&2
  exit 1
fi

if ! health="$(curl -fsS --max-time 10 "$url/api/health")"; then
  echo "dev-remote: $url/api/health did not answer. Is Tailscale up on this laptop, and jarvis-web running on the server?" >&2
  exit 1
fi
echo "dev-remote: server health $health"

if lsof -nP -iTCP:5180 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "dev-remote: port 5180 is taken (the rehearsal container? \`docker compose --profile server stop web\`)" >&2
  exit 1
fi

echo "dev-remote: UI on http://127.0.0.1:5180 -> $url"
exec pnpm --filter @jarvis/web exec vite --mode remote
