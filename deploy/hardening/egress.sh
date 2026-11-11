#!/usr/bin/env bash
# H2 hardening (ADR-0016 §4): stop anything running as `jarvis` (worker Bash, check commands, and the
# rootless-Docker containers that run untrusted project code) from reaching the tailnet, private networks,
# cloud metadata or the host's own public addresses. Root-run, idempotent, owner-applied on the server.
#
#   sudo deploy/hardening/egress.sh              # install: rules + systemd unit + rootless-docker DNS config
#   sudo deploy/hardening/egress.sh remove       # uninstall: drop the nftables table, unit and helper
#   sudo deploy/hardening/egress.sh status       # show the live table
#   sudo deploy/hardening/egress.sh load         # (used by the unit at boot) regenerate and load the table
#
# Why it works: in rootless Docker a container's outbound packets leave through slirp4netns/pasta, which
# runs in the host network namespace as uid jarvis. An nftables `output` rule matching `meta skuid jarvis`
# therefore covers the engine, its children AND every container. root, tailscaled, systemd-resolved,
# alloy and sshd run as other uids and are not touched, so SSH over Tailscale keeps working.
#
# Assumption (verify with deploy/hardening/verify-egress.sh): jarvis needs no private-range destination.
# Postgres, the web preview and the OTLP agent are on loopback (allowed); GitHub, npm, Docker Hub,
# Infisical, healthchecks.io and the Anthropic API are public. If a target repo's checks must reach a
# private host, add that one address to EXTRA_ALLOW below, not a range.
set -euo pipefail

TABLE="inet jarvis_egress"
RUN_AS="${EGRESS_USER:-jarvis}"
HELPER=/usr/local/sbin/jarvis-egress
UNIT=/etc/systemd/system/jarvis-egress.service
# Public resolvers handed to containers (kept in one place; also written into daemon.json).
DNS_SERVERS=(1.1.1.1 9.9.9.9)
# Optional: space-separated IPs/CIDRs exempt from the drop list (e.g. a private registry mirror).
# Persisted in the root-owned /etc/default/jarvis-egress (EGRESS_EXTRA_ALLOW="ip ip"), read at every load.
DEFAULTS=/etc/default/jarvis-egress
# shellcheck disable=SC1090
[ ! -r "$DEFAULTS" ] || . "$DEFAULTS"
EXTRA_ALLOW="${EGRESS_EXTRA_ALLOW:-}"

BLOCK4="100.64.0.0/10, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16"
BLOCK6="fd7a:115c:a1e0::/48, fc00::/7, fe80::/10"

need_root() {
  [ "$(id -u)" -eq 0 ] || {
    echo "egress: run as root" >&2
    exit 1
  }
}

# Global-scope addresses of this host: its public IPv4/IPv6 (and the tailnet one, already in the blocked ranges).
host_addrs() { # $1 = 4|6
  ip -o -"$1" addr show scope global | awk '{print $4}' | cut -d/ -f1 | sort -u | paste -sd, - | sed 's/,/, /g'
}

ruleset() {
  local uid own4 own6 allow4="" allow6="" a
  uid="$(id -u "$RUN_AS")"
  own4="$(host_addrs 4)"
  own6="$(host_addrs 6)"
  for a in $EXTRA_ALLOW; do
    case "$a" in
      *:*) allow6="${allow6:+$allow6, }$a" ;;
      *) allow4="${allow4:+$allow4, }$a" ;;
    esac
  done
  local allow_rules=""
  [ -z "$allow4" ] || allow_rules+="    ip daddr { $allow4 } accept"$'\n'
  [ -z "$allow6" ] || allow_rules+="    ip6 daddr { $allow6 } accept"$'\n'
  # `table X; delete table X; table X {...}` in one file is the atomic "replace or create" idiom.
  cat <<RULES
table $TABLE
delete table $TABLE
table $TABLE {
  chain output {
    type filter hook output priority 0; policy accept;
    meta skuid != $uid accept
    ip daddr 127.0.0.0/8 accept
    ip6 daddr ::1 accept
    ct state established,related accept
${allow_rules}    # MagicDNS: if /etc/resolv.conf points straight at it (not at systemd-resolved on 127.0.0.53), the
    # engine's own lookups (github.com, Infisical) would die. It only answers names; every other tailnet
    # address stays dropped below. Containers use 1.1.1.1 via daemon.json and never need it.
    ip daddr 100.100.100.100 udp dport 53 accept
    ip daddr 100.100.100.100 tcp dport 53 accept
    ip6 daddr fd7a:115c:a1e0::53 udp dport 53 accept
    ip6 daddr fd7a:115c:a1e0::53 tcp dport 53 accept
    ip daddr { $BLOCK4${own4:+, $own4} } counter drop
    ip6 daddr { $BLOCK6${own6:+, $own6} } counter drop
  }
}
RULES
}

cmd_load() {
  need_root
  ruleset | nft -f -
}

cmd_status() {
  need_root
  nft list table $TABLE
}

# Merge the DNS settings into the rootless daemon's config without disturbing other keys.
configure_docker() {
  local home cfg dir uid dns_json
  home="$(getent passwd "$RUN_AS" | cut -d: -f6)"
  dir="$home/.config/docker"
  cfg="$dir/daemon.json"
  uid="$(id -u "$RUN_AS")"
  dns_json="$(printf '"%s",' "${DNS_SERVERS[@]}")"
  dns_json="[${dns_json%,}]"
  runuser -u "$RUN_AS" -- mkdir -p "$dir"
  if [ -s "$cfg" ]; then
    command -v jq >/dev/null || {
      echo "egress: $cfg exists and jq is missing (apt install jq); not touching it" >&2
      exit 1
    }
    jq -e . "$cfg" >/dev/null || {
      echo "egress: $cfg is not valid JSON; fix it first" >&2
      exit 1
    }
    cp -p "$cfg" "$cfg.bak.$(date +%Y%m%d%H%M%S)"
    jq --argjson dns "$dns_json" '.dns = $dns | ."dns-search" = []' "$cfg" >"$cfg.new"
  else
    printf '{\n  "dns": %s,\n  "dns-search": []\n}\n' "$dns_json" >"$cfg.new"
  fi
  chown "$RUN_AS": "$cfg.new"
  mv "$cfg.new" "$cfg"
  echo "egress: wrote $cfg"
  # Restart the user's docker so new containers pick it up (running containers keep the old resolv.conf).
  if runuser -u "$RUN_AS" -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
    systemctl --user is-active docker >/dev/null 2>&1; then
    echo "egress: restarting rootless docker (containers restart per their policy, Postgres briefly goes away)"
    runuser -u "$RUN_AS" -- env XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" \
      systemctl --user restart docker
  else
    echo "egress: user docker is not running; the config applies on its next start"
  fi
}

cmd_install() {
  need_root
  command -v nft >/dev/null || {
    echo "egress: nft not found (apt install nftables)" >&2
    exit 1
  }
  id "$RUN_AS" >/dev/null
  install -o root -g root -m 0755 "$(readlink -f "$0")" "$HELPER"
  if [ ! -e "$DEFAULTS" ]; then
    printf '# Extra IPs/CIDRs the jarvis uid may reach despite the egress filter (space-separated).\nEGRESS_EXTRA_ALLOW=""\n' >"$DEFAULTS"
    chmod 0644 "$DEFAULTS"
  fi
  echo "egress: resolver check: $(grep -E '^nameserver' /etc/resolv.conf | tr '\n' ' ')"
  cat >"$UNIT" <<UNITEOF
[Unit]
Description=Jarvis egress filter for uid $RUN_AS (nftables)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$HELPER load
ExecStop=/usr/sbin/nft delete table $TABLE

[Install]
WantedBy=multi-user.target
UNITEOF
  chmod 0644 "$UNIT"
  systemctl daemon-reload
  systemctl enable jarvis-egress.service
  systemctl restart jarvis-egress.service
  echo "egress: table loaded"
  nft list table $TABLE | sed 's/^/  /'
  configure_docker
  echo "egress: done. Verify: deploy/hardening/verify-egress.sh (as root, from the checkout)"
}

cmd_remove() {
  need_root
  systemctl disable --now jarvis-egress.service 2>/dev/null || true
  nft delete table $TABLE 2>/dev/null || true
  rm -f "$UNIT" "$HELPER"
  systemctl daemon-reload
  echo "egress: removed (daemon.json DNS settings left in place; edit ~$RUN_AS/.config/docker/daemon.json to revert)"
}

case "${1:-install}" in
  install) cmd_install ;;
  load) cmd_load ;;
  status) cmd_status ;;
  remove) cmd_remove ;;
  *)
    echo "usage: $0 [install|remove|status|load]" >&2
    exit 2
    ;;
esac
