#!/usr/bin/env bash
# One-time, owner-run, as root on the server: install the root-owned deploy entrypoint.
#   sudo deploy/root/install-root-deploy.sh [path-to-reviewed-jarvis-deploy]
# Reads the source from the checkout, so REVIEW the file (or the commit) before running; the checkout is
# jarvis-writable. Re-run it by hand after you intentionally change deploy/root/jarvis-deploy. A deploy
# never runs this.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || {
  echo "install-root-deploy: run as root" >&2
  exit 1
}
src="${1:-$(dirname "$(readlink -f "$0")")/jarvis-deploy}"
bash -n "$src"
install -o root -g root -m 0755 "$src" /usr/local/sbin/jarvis-deploy
echo "installed /usr/local/sbin/jarvis-deploy (sha256 $(sha256sum /usr/local/sbin/jarvis-deploy | cut -d' ' -f1))"
