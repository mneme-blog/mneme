#!/usr/bin/env bash
#
# Regression check for mneme-updater.sh.
#
#   ./deploy/updater/updater-test.sh
#
# The agent restarts production stacks, so it needs to be exercised somewhere
# that is not a production stack. This runs it against a stubbed `prod.sh` and a
# stubbed `docker`, driving the paths that matter and that are otherwise only
# ever discovered in anger:
#
#   - a happy-path update records installed/previous/schema/archive correctly
#   - a new version that never becomes healthy is rolled back AUTOMATICALLY
#   - a failed image pull changes nothing (the version pin is restored)
#   - a failed pre-update backup aborts before anything is touched
#   - a rollback returns to the recorded previous version
#   - a bogus tag is refused even if it somehow reaches the spool
#   - a second run cannot start while one holds the lock
#
# No Docker, no network, no root.

set -Eeuo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
AGENT="$HERE/mneme-updater.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
check() { # check <description> <expected> <actual>
  if [[ $2 == "$3" ]]; then ok "$1"; else bad "$1: expected '$2', got '$3'"; fi
}

# ── the fake world ──────────────────────────────────────────────────────────
#
# One stub stands in for `deploy/prod.sh` and one for `docker`. Their behaviour
# is steered by files in $WORK/ctl, so a test can say "the pull fails" or "the
# container never becomes healthy" without editing the stubs.

setup_scenario() {
  rm -rf "$WORK/repo" "$WORK/spool" "$WORK/ctl"
  mkdir -p "$WORK/repo/deploy" "$WORK/spool" "$WORK/ctl" "$WORK/bin"

  : >"$WORK/ctl/calls"
  echo starting >"$WORK/ctl/health"
  # Which `up` the stack starts reporting healthy on. 1 = straight away. Setting
  # it to 2 models the case the whole feature exists for: the new version never
  # comes up, and the version put back afterwards does.
  echo 1 >"$WORK/ctl/healthy_from_up"
  echo 0 >"$WORK/ctl/pull_fails"
  echo 0 >"$WORK/ctl/backup_fails"
  echo v0.2.0 >"$WORK/ctl/running_version"
  echo 4 >"$WORK/ctl/running_schema"

  cat >"$WORK/repo/deploy/prod.sh" <<'STUB'
#!/usr/bin/env bash
# Stub compose wrapper. Records every invocation and fakes just enough output.
set -uo pipefail
CTL=${CTL:?}
printf '%s\n' "$*" >>"$CTL/calls"
case "$1" in
  pull)
    [[ $(cat "$CTL/pull_fails") == 1 ]] && exit 1
    exit 0 ;;
  up|stop|restart) exit 0 ;;
  ps) echo "fake-container-id"; exit 0 ;;
  exec)
    shift; [[ ${1:-} == -T ]] && shift
    svc=${1:-}; shift
    case "$svc/${1:-}/${2:-}" in
      server//journald|server/\/journald/*)
        case "${2:-}" in
          version)     cat "$CTL/running_version"; exit 0 ;;
          schema-info) printf '{"schema":%s,"min_safe_schema":0}\n' "$(cat "$CTL/running_schema")"; exit 0 ;;
          backup)
            [[ $(cat "$CTL/backup_fails") == 1 ]] && { echo "backup failed: disk full"; exit 1; }
            echo "wrote /backups/mneme-20260801T120000Z.tar.gz (1234 bytes)"; exit 0 ;;
          restore)     echo "restored"; exit 0 ;;
        esac ;;
    esac
    # psql and anything else: succeed quietly
    exit 0 ;;
esac
exit 0
STUB
  chmod +x "$WORK/repo/deploy/prod.sh"

  cat >"$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
# Only `docker inspect` is reached from the agent's health gate.
CTL=${CTL:?}
if [[ $1 == inspect ]]; then
  case "$*" in
    *State.Running*) echo true ;;
    *)
      ups=$(grep -c '^up ' "$CTL/calls" 2>/dev/null || echo 0)
      if (( ups >= $(cat "$CTL/healthy_from_up") )); then echo healthy; else cat "$CTL/health"; fi ;;
  esac
  exit 0
fi
exit 0
STUB
  chmod +x "$WORK/bin/docker"
}

run_agent() {
  CTL="$WORK/ctl" \
  MNEME_UPDATER_CONF=/dev/null \
  REPO_DIR="$WORK/repo" \
  SPOOL_DIR="$WORK/spool" \
  HEALTH_TIMEOUT=6 \
  SITE_PROBE_URL="" \
  PATH="$WORK/bin:$PATH" \
    bash "$AGENT" >>"$WORK/agent.out" 2>&1
  return $?
}

request() { printf '%s\n' "$1" >"$WORK/spool/request.json"; }
state()   { jq -r "$1" "$WORK/spool/state.json"; }
pin()     { grep -E "^$1=" "$WORK/repo/deploy/version.env" 2>/dev/null | cut -d= -f2- || true; }
called()  { grep -qF "$1" "$WORK/ctl/calls"; }

command -v jq >/dev/null || { echo "this test needs jq"; exit 1; }

# ── tests ───────────────────────────────────────────────────────────────────

echo "a successful update"
setup_scenario
request '{"id":"r1","action":"update","tag":"v0.3.0"}'
run_agent || true
check "result is success"        success   "$(state .result)"
check "phase is done"            "done"    "$(state .phase)"
check "not running"              false     "$(state .running)"
check "installed is the new tag" v0.3.0    "$(state .installed)"
check "previous is the old tag"  v0.2.0    "$(state .previous)"
check "old schema recorded"      4         "$(state .previous_schema)"
check "backup archive recorded"  mneme-20260801T120000Z.tar.gz "$(state .backup_archive)"
check "version pin updated"      v0.3.0    "$(pin MNEME_VERSION)"
check "server image pinned"      ghcr.io/plasticparticle/mneme-server:v0.3.0 "$(pin MNEME_SERVER_IMAGE)"
check "web image pinned"         ghcr.io/plasticparticle/mneme-web:v0.3.0    "$(pin MNEME_WEB_IMAGE)"
if called "up -d --no-build server web"; then ok "brought the stack up without building"
  else bad "did not run 'up -d --no-build server web'"; fi
if [[ ! -f $WORK/spool/request.json ]]; then ok "request was consumed"
  else bad "request file survived the run"; fi

echo
echo "a main build updates like a release (immutable per-commit tag)"
setup_scenario
request '{"id":"r1m","action":"update","tag":"main-abc1234"}'
run_agent || true
check "result is success"        success      "$(state .result)"
check "installed is the main build" main-abc1234 "$(state .installed)"
check "previous is the old tag"  v0.2.0       "$(state .previous)"
check "version pin updated"      main-abc1234 "$(pin MNEME_VERSION)"
check "server image pinned"      ghcr.io/plasticparticle/mneme-server:main-abc1234 "$(pin MNEME_SERVER_IMAGE)"
check "web image pinned"         ghcr.io/plasticparticle/mneme-web:main-abc1234    "$(pin MNEME_WEB_IMAGE)"

echo
echo "a version that never becomes healthy is rolled back automatically"
setup_scenario
echo 2 >"$WORK/ctl/healthy_from_up"   # the new version fails; the restored one is fine
request '{"id":"r2","action":"update","tag":"v0.3.0"}'
run_agent || true
check "result is rolled_back"    rolled_back "$(state .result)"
check "not left running"         false       "$(state .running)"
check "pin restored to nothing"  ""          "$(pin MNEME_VERSION)"
if grep -q "rolling back" "$WORK/spool/update.log"; then ok "logged the rollback"
  else bad "no rollback logged"; fi
check "a backup was still taken" mneme-20260801T120000Z.tar.gz "$(state .backup_archive)"

echo
echo "when the rollback ALSO fails, it says so instead of claiming success"
setup_scenario
echo 99 >"$WORK/ctl/healthy_from_up"   # nothing ever becomes healthy
request '{"id":"r2b","action":"update","tag":"v0.3.0"}'
run_agent || true
check "result is failed"   failed "$(state .result)"
if [[ $(state .error) == *"$(state .backup_archive)"* ]]; then ok "points the operator at the backup"
  else bad "the error does not name the pre-update archive: $(state .error)"; fi

echo
echo "a failed pull changes nothing"
setup_scenario
printf 'MNEME_VERSION=v0.2.0\n' >"$WORK/repo/deploy/version.env"
echo 1 >"$WORK/ctl/pull_fails"
request '{"id":"r3","action":"update","tag":"v0.3.0"}'
run_agent || true
check "result is failed"          failed  "$(state .result)"
check "original pin restored"     v0.2.0  "$(pin MNEME_VERSION)"
if ! called "up -d --no-build"; then ok "never restarted the stack"
  else bad "restarted the stack after a failed pull"; fi

echo
echo "a failed backup aborts before anything is touched"
setup_scenario
echo 1 >"$WORK/ctl/backup_fails"
request '{"id":"r4","action":"update","tag":"v0.3.0"}'
run_agent || true
check "result is failed"       failed "$(state .result)"
if ! called "pull"; then ok "never pulled"; else bad "pulled despite no backup"; fi
if [[ ! -f $WORK/repo/deploy/version.env ]]; then ok "never wrote a version pin"
  else bad "wrote a version pin"; fi

echo
echo "a rollback returns to the recorded previous version"
setup_scenario
cat >"$WORK/spool/state.json" <<'EOF'
{"installed":"v0.3.0","previous":"v0.2.0","previous_schema":4,
 "backup_archive":"mneme-20260801T120000Z.tar.gz","phase":"done","running":false}
EOF
request '{"id":"r5","action":"rollback","deep":false}'
run_agent || true
check "result is success"      success "$(state .result)"
check "installed is the old tag" v0.2.0 "$(state .installed)"
check "pin points back"        v0.2.0  "$(pin MNEME_VERSION)"
check "no further rollback offered" "" "$(state .previous)"

echo
echo "a deep rollback rebuilds the database and restores the archive"
setup_scenario
cat >"$WORK/spool/state.json" <<'EOF'
{"installed":"v0.3.0","previous":"v0.2.0","previous_schema":3,
 "backup_archive":"mneme-20260801T120000Z.tar.gz","phase":"done","running":false}
EOF
request '{"id":"r6","action":"rollback","deep":true}'
run_agent || true
check "result is success" success "$(state .result)"
if called "DROP DATABASE"; then ok "rebuilt the database"; else bad "did not rebuild the database"; fi
if called "/journald restore /backups/mneme-20260801T120000Z.tar.gz --yes"; then ok "replayed the archive"
  else bad "did not replay the archive"; fi

echo
echo "a bogus tag is refused at the agent, not just at the relay"
for tag in "latest" "v1.2" "ghcr.io/evil/x:v1.0.0" "v1.0.0 --privileged" \
           "main" "main-abc123" "main-ABC1234" "main-xyzxyzx"; do
  setup_scenario
  request "$(jq -nc --arg t "$tag" '{id:"rX",action:"update",tag:$t}')"
  run_agent || true
  if [[ $(state .result) == failed ]] && ! called pull; then ok "refused '$tag'"
    else bad "accepted '$tag'"; fi
done

echo
echo "an unknown action is refused"
setup_scenario
request '{"id":"r7","action":"rm -rf /"}'
run_agent || true
check "result is failed" failed "$(state .result)"

echo
echo "a run cannot start while another holds the lock"
setup_scenario
request '{"id":"r8","action":"update","tag":"v0.3.0"}'
(
  exec 9>"$WORK/spool/.lock"
  flock 9
  run_agent && echo "exit=0" >"$WORK/locked.out" || echo "exit=$?" >"$WORK/locked.out"
)
check "the second run backs off cleanly" "exit=0" "$(cat "$WORK/locked.out")"
if [[ -f $WORK/spool/request.json ]]; then ok "left the request for the holder"
  else bad "consumed the request while locked out"; fi

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
