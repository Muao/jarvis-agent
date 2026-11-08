#!/usr/bin/env bash
# Run a command with secrets from Infisical (ADR-0016).
#   INFISICAL_CLIENT_ID set -> log in with the machine identity, then `infisical run`.
#   otherwise               -> run the command unchanged (laptop fallback: ~/.jarvis/.env).
# Assumes Infisical Cloud US (no --domain); set INFISICAL_API_URL in the env file for another host.
# Credentials travel through the environment only, never argv, so they stay out of `ps`.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: with-secrets.sh <command> [args...]" >&2
  exit 64
fi

if [ -z "${INFISICAL_CLIENT_ID:-}" ]; then
  echo "with-secrets: INFISICAL_CLIENT_ID not set, running without Infisical (local fallback)" >&2
  exec "$@"
fi

: "${INFISICAL_CLIENT_SECRET:?INFISICAL_CLIENT_SECRET is required with INFISICAL_CLIENT_ID}"
: "${INFISICAL_PROJECT_ID:?INFISICAL_PROJECT_ID is required with INFISICAL_CLIENT_ID}"

# The CLI reads these two variables for universal-auth login.
INFISICAL_TOKEN="$(
  INFISICAL_UNIVERSAL_AUTH_CLIENT_ID="$INFISICAL_CLIENT_ID" \
  INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET="$INFISICAL_CLIENT_SECRET" \
    infisical login --method=universal-auth --silent --plain
)"
if [ -z "$INFISICAL_TOKEN" ]; then
  echo "with-secrets: Infisical login returned an empty token" >&2
  exit 1
fi
export INFISICAL_TOKEN
echo "with-secrets: using Infisical (env ${JARVIS_ENV:-prod})" >&2

# The machine-identity credentials are no longer needed by the child.
unset INFISICAL_CLIENT_ID INFISICAL_CLIENT_SECRET

exec infisical run --env="${JARVIS_ENV:-prod}" --projectId "$INFISICAL_PROJECT_ID" -- "$@"
