#!/bin/bash
# Installs dependencies into the container's own node_modules volumes (the host's macOS binaries are
# never visible here), on every start; it is fast when the volumes are already populated. Then runs the command.
set -euo pipefail
pnpm install --frozen-lockfile
exec "$@"
