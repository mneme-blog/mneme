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
DROPIN_DIR=$UNIT_DIR/mneme-updater.service.d
DROPIN=$DROPIN_DIR/10-paths.conf

die() { echo "error: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (sudo $0)"

if [[ ${1:-} == --uninstall ]]; then
  systemctl disable --now mneme-updater.path 2>/dev/null || true
  rm -f "$UNIT_DIR/mneme-updater.path" "$UNIT_DIR/mneme-updater.service"
  rm -f "$DROPIN"
  rmdir "$DROPIN_DIR" 2>/dev/null || true
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

# The service runs with ProtectHome=tmpfs, which leaves /home and /root empty for
# it. A checkout in a home directory is the ordinary case for a homelab, so bind
# exactly the paths this agent needs back in — and nothing else, so other users'
# homes stay hidden. Anywhere outside /home and /root needs no help.
install -d -m 0755 "$DROPIN_DIR"
{
  echo "# Written by deploy/updater/install.sh — re-run the installer instead of editing."
  echo "#"
  echo "# ProtectHome=tmpfs in the unit empties /home and /root for this service."
  echo "# These are the paths it still has to see. Nothing here comes from the relay."
  echo "[Service]"
  bound=""
  for dir in "$REPO_DIR" "$SPOOL_DIR"; do
    case $dir in
      /home/* | /root | /root/*) echo "BindPaths=$dir"; bound="yes" ;;
    esac
  done
  [[ -n $bound ]] || echo "# (nothing to bind — neither path lives under /home or /root)"
} >"$DROPIN"
chmod 0644 "$DROPIN"

systemctl daemon-reload
systemctl enable --now mneme-updater.path

# The agent's own script is installed root-owned under /usr/local/lib, but the
# thing it runs — deploy/prod.sh, which in turn sources deploy/version.env — stays
# in the checkout, wherever that is. A checkout under a home directory is the
# documented normal case, and it is owned by the operator's account, not root. So
# say plainly what that means: writing those files is equivalent to running code
# as root at the next update. Not fatal (docker-group membership is already
# root-equivalent on most hosts, and refusing to install would help nobody), but
# it must not be something you have to work out for yourself.
unsafe=()
for p in "$REPO_DIR" "$REPO_DIR/deploy" "$REPO_DIR/deploy/prod.sh" "$REPO_DIR/deploy/version.env"; do
  [[ -e $p ]] || continue
  owner=$(stat -c %u "$p")
  perms=$(stat -c %a "$p")
  if ((owner != 0)) || ((8#$perms & 8#022)); then
    unsafe+=("$p ($(stat -c '%U %a' "$p"))")
  fi
done
if ((${#unsafe[@]})); then
  cat >&2 <<EOF

⚠️  This agent runs as root and executes files from the checkout, which root does
    not exclusively own:

$(printf '      %s\n' "${unsafe[@]}")

    Anyone who can write those paths can run code as root the next time an
    update is applied. To close that:

        sudo chown -R root:root $REPO_DIR/deploy
        sudo chmod -R go-w $REPO_DIR/deploy

    (You will then need sudo to edit deploy/ — which is the point.) The agent
    repeats this warning in its own log on every run. See docs/SECURITY.md §6.17.
EOF
fi

# Prove the service can actually reach the checkout from inside its sandbox. With
# no request in the spool the agent runs its preflight and exits, so this is safe
# to run here — and it turns a misconfigured path into an install-time error
# instead of a baffling failure during the operator's first real update.
if [[ -e "$SPOOL_DIR/request.json" ]]; then
  echo "note: an update request is already queued; skipping the self-test."
elif systemctl start mneme-updater.service; then
  echo "Self-test passed: the service can reach $REPO_DIR."
else
  journalctl -u mneme-updater.service -n 20 --no-pager >&2 || true
  die "the updater cannot reach $REPO_DIR from inside its systemd sandbox (see the log above)"
fi

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
