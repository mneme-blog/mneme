#!/usr/bin/env bash
#
# Installs the Mneme updater agent: the host-side component that applies
# one-click updates requested from the /admin dashboard.
#
#   sudo ./deploy/updater/install.sh
#
# It installs the script, writes /etc/mneme-updater.conf, enables the systemd
# path unit, creates the spool directory, and tells you the two lines to add to
# .env.prod. Until those lines are set the relay has no spool configured and the
# dashboard shows no update button — installing this does not silently switch
# the feature on.
#
# Uninstall:  ./deploy/updater/install.sh --uninstall

set -Eeuo pipefail

REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SPOOL_DIR=${SPOOL_DIR:-/var/lib/mneme/spool}
LIB_DIR=/usr/local/lib/mneme
CONF=/etc/mneme-updater.conf
UNIT_DIR=/etc/systemd/system

die() { echo "error: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (sudo $0)"

if [[ ${1:-} == --uninstall ]]; then
  systemctl disable --now mneme-updater.path 2>/dev/null || true
  rm -f "$UNIT_DIR/mneme-updater.path" "$UNIT_DIR/mneme-updater.service"
  rm -f "$LIB_DIR/mneme-updater.sh"
  systemctl daemon-reload
  echo "Removed the updater units and script."
  echo "Left in place (they hold state): $CONF and $SPOOL_DIR"
  echo "Remove UPDATE_SPOOL_DIR from .env.prod and restart the stack to hide the button."
  exit 0
fi

command -v systemctl >/dev/null || die "systemd is required"
command -v docker >/dev/null || die "docker is required"
for tool in jq curl flock; do
  command -v "$tool" >/dev/null || die "$tool is required (apt install jq curl util-linux)"
done
[[ -f "$REPO_DIR/docker-compose.prod.yml" ]] || die "$REPO_DIR does not look like the Mneme checkout"
[[ -f "$REPO_DIR/.env.prod" ]] || die "$REPO_DIR/.env.prod not found — set the stack up first"

# The site probe is optional but worth having: container health proves the relay
# is up, this proves the app is actually being served. Read the address the
# stack already knows about rather than asking again.
SITE_PROBE_URL=${SITE_PROBE_URL:-https://127.0.0.1/}

install -d -m 0755 "$LIB_DIR"
install -m 0755 "$REPO_DIR/deploy/updater/mneme-updater.sh" "$LIB_DIR/mneme-updater.sh"

# The spool is shared with the relay container, which runs as root, so root
# ownership is correct. 0750 keeps other host users out of the request path —
# writing a request here is equivalent to asking for a stack restart.
install -d -m 0750 "$SPOOL_DIR"

cat >"$CONF" <<EOF
# Mneme updater configuration — written by deploy/updater/install.sh
# Nothing here is influenced by the relay; the relay can only ever ask for
# "update to <validated tag>" or "roll back".
REPO_DIR=$REPO_DIR
SPOOL_DIR=$SPOOL_DIR
REGISTRY=ghcr.io/plasticparticle
HEALTH_TIMEOUT=240
# End-to-end probe after the containers report healthy. Empty to skip.
SITE_PROBE_URL=$SITE_PROBE_URL
EOF
chmod 0600 "$CONF"

# The path unit's PathExists is baked into the unit file, so keep it in step
# with the spool location chosen here.
sed "s#^PathExists=.*#PathExists=$SPOOL_DIR/request.json#" \
  "$REPO_DIR/deploy/updater/mneme-updater.path" >"$UNIT_DIR/mneme-updater.path"
install -m 0644 "$REPO_DIR/deploy/updater/mneme-updater.service" "$UNIT_DIR/mneme-updater.service"

systemctl daemon-reload
systemctl enable --now mneme-updater.path

cat <<EOF

Updater installed and watching $SPOOL_DIR/request.json

One step left — add these to $REPO_DIR/.env.prod, then restart the stack:

    UPDATE_SPOOL_HOST_DIR=$SPOOL_DIR
    UPDATE_SPOOL_DIR=/var/lib/mneme/spool

    ./deploy/prod.sh up -d

The first line shares the directory with the relay container; the second is what
actually turns the "Update" button on in /admin. Without them the dashboard keeps
reporting new releases and simply offers no button.

Logs:   journalctl -u mneme-updater.service -f
        tail -f $SPOOL_DIR/update.log
EOF
