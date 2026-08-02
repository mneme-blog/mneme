#!/usr/bin/env bash
#
# mneme-updater — applies one-click updates requested from the /admin dashboard.
#
# This is the privileged half of the update mechanism. It runs on the HOST as
# root (systemd path unit → oneshot service), not in a container, because the
# thing being replaced is the relay's own container: anything the relay started
# would be killed halfway through the swap. Keeping it here also means the
# Docker socket is never exposed inside the stack — the relay stays the least
# privileged component, which is the whole premise of the deployment (§1).
#
# The relay can only ask for two things, and cannot say how they are done:
#
#   {"action":"update","tag":"v0.3.0"}   move the stack to a published release,
#                                        or tag "main-<sha>" for a CI-built
#                                        image of a commit on main
#   {"action":"rollback","deep":false}   return to the version recorded here
#
# The tag is re-validated below and pasted into a fixed image reference. A fully
# compromised relay can therefore request a downgrade to a published Mneme
# release or a CI-published main build, and nothing else — no image, registry,
# path, or command comes from it.
#
# Every update takes a backup FIRST and health-gates the result, rolling back
# automatically if the new version does not come up. See docs/MAINTENANCE.md.

set -Eeuo pipefail

# ── configuration ───────────────────────────────────────────────────────────
# Written by install.sh. Everything here is operator-controlled; nothing in this
# file is influenced by the relay.
CONF=${MNEME_UPDATER_CONF:-/etc/mneme-updater.conf}
# shellcheck disable=SC1090
[[ -f $CONF ]] && source "$CONF"

REPO_DIR=${REPO_DIR:?REPO_DIR is not set (the checkout holding docker-compose.prod.yml)}
SPOOL_DIR=${SPOOL_DIR:?SPOOL_DIR is not set (the directory shared with the relay)}
# The only registry this agent will ever pull from. Not configurable from the
# request — that is the point.
REGISTRY=${REGISTRY:-ghcr.io/plasticparticle}
SERVER_REPO=${SERVER_REPO:-$REGISTRY/mneme-server}
WEB_REPO=${WEB_REPO:-$REGISTRY/mneme-web}
# How long the new version gets to report healthy before it is judged failed.
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-240}
# Optional end-to-end probe through Caddy, e.g. https://127.0.0.1/mneme/.
# Container health alone proves the relay is up; this proves the site is served.
SITE_PROBE_URL=${SITE_PROBE_URL:-}

COMPOSE="$REPO_DIR/deploy/prod.sh"
VERSION_ENV="$REPO_DIR/deploy/version.env"
REQUEST_FILE="$SPOOL_DIR/request.json"
STATE_FILE="$SPOOL_DIR/state.json"
LOG_FILE="$SPOOL_DIR/update.log"
LOCK_FILE="$SPOOL_DIR/.lock"

# Mirrors deploy.ValidTag in the relay. Duplicated on purpose: this side must not
# depend on the relay having validated anything. Release tags plus immutable
# per-commit main builds (main-<sha>, published by CI) — never the bare moving
# tag "main", which would make the recorded "previous" meaningless for rollback.
TAG_RE='^(v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?|main-[0-9a-f]{7,40})$'

# ── state + logging ─────────────────────────────────────────────────────────

log() {
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
  printf '%s\n' "$line" >>"$LOG_FILE"
  printf '%s\n' "$line" >&2
}

# Keep the log bounded; the dashboard tails it and nobody rotates it for us.
rotate_log() {
  [[ -f $LOG_FILE ]] || return 0
  local size
  size=$(stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)
  ((size > 1048576)) && mv -f "$LOG_FILE" "$LOG_FILE.1"
  return 0
}

# Fields carried across a run so every state write is complete rather than a
# patch (the relay reads whole documents).
S_REQUEST_ID=""; S_ACTION=""; S_FROM=""; S_TO=""; S_STARTED=""
S_INSTALLED=""; S_PREVIOUS=""; S_PREV_SCHEMA=0; S_ARCHIVE=""

load_state() {
  [[ -f $STATE_FILE ]] || return 0
  S_INSTALLED=$(jq -r '.installed // ""' "$STATE_FILE")
  S_PREVIOUS=$(jq -r '.previous // ""' "$STATE_FILE")
  S_PREV_SCHEMA=$(jq -r '.previous_schema // 0' "$STATE_FILE")
  S_ARCHIVE=$(jq -r '.backup_archive // ""' "$STATE_FILE")
}

# write_state <phase> <running true|false> [result] [error]
write_state() {
  local phase=$1 running=$2 result=${3:-} error=${4:-}
  local finished=""
  [[ $running == false ]] && finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  jq -n \
    --arg request_id "$S_REQUEST_ID" --arg action "$S_ACTION" \
    --arg phase "$phase" --argjson running "$running" \
    --arg from "$S_FROM" --arg to "$S_TO" \
    --arg started "$S_STARTED" --arg finished "$finished" \
    --arg result "$result" --arg error "$error" \
    --arg archive "$S_ARCHIVE" --arg installed "$S_INSTALLED" \
    --arg previous "$S_PREVIOUS" --argjson previous_schema "${S_PREV_SCHEMA:-0}" \
    '{request_id:$request_id, action:$action, phase:$phase, running:$running,
      from:$from, to:$to, result:$result, error:$error,
      backup_archive:$archive, installed:$installed,
      previous:$previous, previous_schema:$previous_schema}
     + (if $started  != "" then {started_at:$started}   else {} end)
     + (if $finished != "" then {finished_at:$finished} else {} end)' \
    >"$STATE_FILE.partial"
  # The relay may read at any moment; never let it see a half-written document.
  mv -f "$STATE_FILE.partial" "$STATE_FILE"
}

# Any unexpected failure still has to leave a truthful state behind, or the
# dashboard would show "running" forever.
on_error() {
  local code=$?
  log "FAILED (exit $code) at line ${BASH_LINENO[0]}"
  write_state failed false failed "the updater exited unexpectedly (see the log)"
  exit "$code"
}

# ── helpers ─────────────────────────────────────────────────────────────────

compose() { (cd "$REPO_DIR" && "$COMPOSE" "$@"); }

# The version currently pinned, i.e. what is running now.
current_version() {
  if [[ -f $VERSION_ENV ]]; then
    local v
    v=$(grep -E '^MNEME_VERSION=' "$VERSION_ENV" | tail -n1 | cut -d= -f2- || true)
    [[ -n $v ]] && { printf '%s' "$v"; return 0; }
  fi
  # Never pinned before: ask the running binary what it is.
  compose exec -T server /journald version 2>/dev/null | tr -d '\r\n' || printf 'unknown'
}

# The migration head the running build carries. Recorded before an update so a
# later rollback can tell whether the old binary can still read the new schema.
current_schema() {
  compose exec -T server /journald schema-info 2>/dev/null | jq -r '.schema // 0' || echo 0
}

# Put the version pin back exactly as it was. An empty saved path means there was
# no pin before (a source deployment that has never been updated), and the
# faithful restoration of that is to have no pin file at all.
restore_pin_file() {
  local saved=$1
  if [[ -n $saved && -f $saved ]]; then
    mv -f "$saved" "$VERSION_ENV"
  else
    rm -f "$VERSION_ENV"
  fi
}

pin_version() {
  local tag=$1
  cat >"$VERSION_ENV.partial" <<EOF
# Generated by mneme-updater — do not edit by hand.
# Rewritten on every apply and rollback; deploy/prod.sh sources it so that
# \`prod.sh up -d\` brings up the version that is actually installed.
MNEME_VERSION=$tag
MNEME_SERVER_IMAGE=$SERVER_REPO:$tag
MNEME_WEB_IMAGE=$WEB_REPO:$tag
EOF
  mv -f "$VERSION_ENV.partial" "$VERSION_ENV"
}

# Wait for the relay container to report healthy (the HEALTHCHECK runs
# `journald healthcheck` → /readyz, which is only OK once migrations have
# applied and Postgres is reachable). Then, optionally, prove the site is
# actually served end-to-end through Caddy.
wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) cid status
  while ((SECONDS < deadline)); do
    cid=$(compose ps -q server 2>/dev/null || true)
    if [[ -n $cid ]]; then
      status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo missing)
      case $status in
        healthy) log "relay is healthy"; probe_site; return $? ;;
        unhealthy) log "relay reported unhealthy"; return 1 ;;
        none)
          # No healthcheck in this image (an older release being rolled back to).
          # Fall back to the container simply staying up.
          if [[ $(docker inspect --format '{{.State.Running}}' "$cid") == true ]]; then
            sleep 10
            [[ $(docker inspect --format '{{.State.Running}}' "$cid") == true ]] || return 1
            log "relay is running (image has no healthcheck)"
            probe_site; return $?
          fi
          ;;
      esac
    fi
    sleep 5
  done
  log "timed out after ${HEALTH_TIMEOUT}s waiting for the relay to become healthy"
  return 1
}

probe_site() {
  [[ -n $SITE_PROBE_URL ]] || return 0
  local deadline=$((SECONDS + 60))
  while ((SECONDS < deadline)); do
    if curl -fsSk --max-time 10 -o /dev/null "$SITE_PROBE_URL"; then
      log "site probe OK ($SITE_PROBE_URL)"
      return 0
    fi
    sleep 5
  done
  log "site probe FAILED ($SITE_PROBE_URL)"
  return 1
}

# Take a backup and echo the archive name. This is what makes an update
# reversible even when a migration is not, so a failure here aborts the update.
take_backup() {
  local out name
  out=$(compose exec -T server /journald backup 2>&1) || {
    log "backup failed: $out"
    return 1
  }
  # "wrote /backups/<name> (N bytes)"
  name=$(printf '%s' "$out" | sed -n 's#^wrote .*/\([^ ]*\) (.*#\1#p' | tail -n1)
  if [[ -z $name ]]; then
    name=$(compose exec -T server /journald list-backups 2>/dev/null | head -n1 | cut -f1 || true)
  fi
  [[ -n $name ]] || { log "backup produced no archive name"; return 1; }
  printf '%s' "$name"
}

# ── actions ─────────────────────────────────────────────────────────────────

do_update() {
  local tag=$1
  S_FROM=$(current_version)
  S_TO=$tag
  local from_schema; from_schema=$(current_schema)

  if [[ $S_FROM == "$tag" ]]; then
    log "already running $tag — nothing to do"
    write_state "done" false success ""
    return 0
  fi

  log "updating $S_FROM → $tag"

  write_state backing-up true
  local archive
  archive=$(take_backup) || {
    write_state failed false failed "the pre-update backup failed; nothing was changed"
    return 1
  }
  S_ARCHIVE=$archive
  log "pre-update backup: $archive"

  # From here on the pin can change, so remember how to put it back.
  local restore_pin=""
  [[ -f $VERSION_ENV ]] && { restore_pin=$(mktemp); cp "$VERSION_ENV" "$restore_pin"; }

  write_state pulling true
  pin_version "$tag"
  if ! compose pull server web; then
    log "pull failed for $tag"
    restore_pin_file "$restore_pin"
    write_state failed false failed "could not pull $tag; nothing was changed"
    return 1
  fi

  write_state starting true
  # --no-build: the updater deploys released images, never the working tree.
  if compose up -d --no-build server web && wait_healthy; then
    log "update to $tag succeeded"
    S_PREVIOUS=$S_FROM
    S_PREV_SCHEMA=$from_schema
    S_INSTALLED=$tag
    [[ -n $restore_pin ]] && rm -f "$restore_pin"
    write_state "done" false success ""
    return 0
  fi

  # The new version did not come up. Put the old one back — this is the path
  # that has to work, so it is deliberately the simplest one: same images that
  # were running minutes ago, still in the local image cache.
  log "$tag failed to come up — rolling back to $S_FROM"
  write_state rolling-back true
  restore_pin_file "$restore_pin"
  if compose up -d --no-build server web && wait_healthy; then
    log "rolled back to $S_FROM"
    write_state "done" false rolled_back "$tag failed to start; the previous version was restored"
    return 0
  fi

  log "ROLLBACK FAILED — manual intervention required"
  write_state failed false failed \
    "$tag failed to start AND the rollback failed. The pre-update backup is $S_ARCHIVE — see docs/MAINTENANCE.md for manual recovery."
  return 1
}

do_rollback() {
  local deep=$1
  load_state
  local target=$S_PREVIOUS
  [[ -n $target ]] || { write_state failed false failed "no previously installed version is recorded"; return 1; }

  S_FROM=$S_INSTALLED
  S_TO=$target
  log "rolling back $S_FROM → $target (deep=$deep)"

  # Even a rollback takes a backup first: the current state may be bad, but it
  # is still the only copy of anything written since the update.
  write_state backing-up true
  local safety
  if safety=$(take_backup); then
    log "pre-rollback backup: $safety"
  else
    log "WARNING: pre-rollback backup failed; continuing"
  fi

  write_state pulling true
  pin_version "$target"
  compose pull server web || log "pull failed; falling back to locally cached images"

  if [[ $deep == true ]]; then
    deep_rollback "$target" || return 1
  else
    write_state starting true
    compose up -d --no-build server web || true
  fi

  write_state verifying true
  if wait_healthy; then
    log "rollback to $target succeeded"
    S_INSTALLED=$target
    S_PREVIOUS=""      # one step back only; there is no rollback-to-the-rollback
    S_PREV_SCHEMA=0
    write_state "done" false success ""
    return 0
  fi

  log "ROLLBACK FAILED — manual intervention required"
  write_state failed false failed "the rollback to $target did not come up healthy; see docs/MAINTENANCE.md"
  return 1
}

# The destructive rollback, for when the update contained a breaking migration.
#
# Migrations are forward-only, so there is no way to un-apply one. The only
# honest path back is to rebuild the database at the OLD schema and replay the
# pre-update archive into it: stop the stack, drop the database, start the old
# binary (which migrates to its own, older head), then restore.
#
# Everything written since the update is lost — that is inherent, not a defect
# of this implementation, and the dashboard says so before the operator commits.
deep_rollback() {
  local target=$1
  local archive=$S_ARCHIVE
  [[ -n $archive ]] || { write_state failed false failed "no pre-update archive recorded; cannot rebuild the database"; return 1; }

  log "DEEP rollback: rebuilding the database at ${target}'s schema and restoring $archive"
  write_state rebuilding true

  compose stop server web || true

  # DROP ... WITH (FORCE) terminates leftover connections (Postgres 13+); the
  # relay is stopped, but backups or a stray psql may still hold one.
  if ! compose exec -T postgres psql -U journal -d postgres -v ON_ERROR_STOP=1 \
    -c 'DROP DATABASE IF EXISTS journal WITH (FORCE)' -c 'CREATE DATABASE journal OWNER journal'; then
    write_state failed false failed "could not rebuild the database; the stack is stopped — see docs/MAINTENANCE.md"
    return 1
  fi

  # Starting the old image migrates the empty database to the old head.
  write_state starting true
  if ! compose up -d --no-build server; then
    write_state failed false failed "the previous version did not start after the database rebuild"
    return 1
  fi
  if ! wait_healthy; then
    write_state failed false failed "the previous version did not become healthy after the database rebuild"
    return 1
  fi

  write_state restoring true
  if ! compose exec -T server /journald restore "/backups/$archive" --yes; then
    write_state failed false failed "the database was rebuilt but restoring $archive failed — the archive is still on disk"
    return 1
  fi

  compose up -d --no-build server web || true
  log "deep rollback restored $archive"
  return 0
}

# ── main ────────────────────────────────────────────────────────────────────

main() {
  mkdir -p "$SPOOL_DIR"
  rotate_log
  [[ -f $REQUEST_FILE ]] || exit 0

  for tool in docker jq curl; do
    command -v "$tool" >/dev/null || { log "missing required tool: $tool"; exit 1; }
  done

  trap on_error ERR

  local request action tag deep
  request=$(cat "$REQUEST_FILE")
  # Consume the request BEFORE acting. A crash mid-run must not leave a request
  # that the path unit re-triggers forever against a half-updated stack.
  rm -f "$REQUEST_FILE"

  if ! jq -e . >/dev/null 2>&1 <<<"$request"; then
    log "ignoring an unreadable request"
    exit 1
  fi
  S_REQUEST_ID=$(jq -r '.id // ""' <<<"$request")
  action=$(jq -r '.action // ""' <<<"$request")
  tag=$(jq -r '.tag // ""' <<<"$request")
  deep=$(jq -r 'if .deep then "true" else "false" end' <<<"$request")
  S_ACTION=$action
  S_STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  load_state

  # The action functions write their own precise failure state before returning
  # non-zero, so they must not reach the ERR trap — it would overwrite a specific
  # diagnosis ("the pull failed, nothing changed") with a generic one.
  case $action in
    update)
      if [[ ! $tag =~ $TAG_RE ]]; then
        log "rejecting request: '$tag' is not a release or main-build tag"
        write_state failed false failed "not a release or main-build tag"
        exit 1
      fi
      do_update "$tag" || exit 1
      ;;
    rollback)
      do_rollback "$deep" || exit 1
      ;;
    *)
      log "rejecting request: unknown action '$action'"
      write_state failed false failed "unknown action"
      exit 1
      ;;
  esac
}

# One run at a time, no matter how the request arrived.
mkdir -p "$SPOOL_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || { echo "mneme-updater: another run holds the lock" >&2; exit 0; }

main "$@"
