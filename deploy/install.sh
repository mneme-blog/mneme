#!/usr/bin/env bash
#
# Guided installer for a self-hosted Mneme deployment.
#
#   curl -fsSL https://raw.githubusercontent.com/mneme-blog/mneme/main/deploy/install.sh | bash
#
# It walks through six steps — check the machine, fetch the source, write
# configuration, download images, start the stack, wait until it is really
# serving — narrating each one and stopping with an explanation (not a stack
# trace) if something is not right.
#
# It is idempotent: re-running updates the checkout, keeps an existing
# .env.prod untouched, and restarts the stack onto the current images.
#
# Nothing here weakens the security model. The installer generates secrets
# locally and never sees, transmits, or stores a recovery phrase — it cannot:
# phrases are created in the browser on first use and never leave it.

set -Eeuo pipefail

REPO_URL=${MNEME_REPO_URL:-https://github.com/mneme-blog/mneme.git}
REF=${MNEME_REF:-main}
DIR=${MNEME_DIR:-}
SITE=${MNEME_SITE_ADDRESS:-}
BACKUPS=${MNEME_BACKUP_DIR:-}
ASSUME_YES=false
INSTALL_DOCKER=false
START=true
STARTED=false

# What "the app is up" means: the relay's readiness probe, through Caddy, on the
# loopback address — so this tests the whole chain (TLS, proxy, relay, database
# migrations) rather than just whether a container exists.
READY_URL="https://127.0.0.1/mneme/readyz"

TOTAL_STEPS=6
STEP_NO=0
ISSUES=0

# ── Presentation ────────────────────────────────────────────────────────────
# Colour only when stdout is a terminal (so `| tee install.log` stays readable),
# and box-drawing characters only when the locale can render them.
if [[ -t 1 ]]; then
  B=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; R=$'\033[0m'
else
  B=""; DIM=""; RED=""; YEL=""; GRN=""; R=""
fi
if [[ ${LC_ALL:-${LC_CTYPE:-${LANG:-}}} == *[Uu][Tt][Ff]* ]]; then
  TICK="✓"; CROSS="✗"; ARROW="▸"; BULLET="•"
else
  TICK="OK"; CROSS="!!"; ARROW=">"; BULLET="-"
fi

# LC_ALL=C so awk treats the input as bytes: a path or a captured log line that
# is not valid in the caller's locale would otherwise make gawk print a
# "Invalid multibyte data" warning into the middle of an error message.
indent() { LC_ALL=C awk '{ if (length($0)) print "    " $0; else print "" }'; }

step() { # step "Title" "one line saying why this step exists"
  STEP_NO=$((STEP_NO + 1))
  printf '\n%s%s Step %d/%d · %s%s\n' "$B" "$ARROW" "$STEP_NO" "$TOTAL_STEPS" "$1" "$R"
  [[ $# -gt 1 ]] && printf '%s%s%s\n' "$DIM" "$(printf '%s' "$2" | fold -s -w 74 | indent)" "$R"
  return 0
}

say()  { printf '%s\n' "$(printf '%s' "$*" | indent)"; }
ok()   { printf '    %s%s%s %s\n' "$GRN" "$TICK" "$R" "$*"; }
note() { printf '    %s%s %s%s\n' "$DIM" "$BULLET" "$*" "$R"; }

# Long-running Docker steps, on one line that never scrolls.
#
# Compose redraws its own progress display in place only while it fits the
# terminal. Pulling this stack is forty-odd layer rows, so on an ordinary
# window the display gives up and prints a fresh frame per tick instead —
# hundreds of near-identical lines scrolling past, which reads like something
# is wrong. So the command's output is captured rather than shown, and a single
# self-updating line stands in for it. The log is kept and printed only if the
# step fails, which is the one time the detail is worth having.
if [[ $TICK == "✓" ]]; then
  FRAMES=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
else
  FRAMES=('|' '/' '-' "\\")
fi
SPIN_LOG=""
SPIN_DETAIL=""   # optional function name; called each tick for a short suffix

spin() { # spin "what it is doing" cmd… — returns the command's exit status
  local label=$1
  shift
  SPIN_LOG=$(mktemp "${TMPDIR:-/tmp}/mneme-install.XXXXXX")
  "$@" >"$SPIN_LOG" 2>&1 &
  local pid=$! start=$SECONDS i=0 rc=0 detail="" secs
  if [[ -t 1 ]]; then
    while kill -0 "$pid" 2>/dev/null; do
      if [[ -n $SPIN_DETAIL ]]; then detail=$("$SPIN_DETAIL" 2>/dev/null) || detail=""; fi
      secs=$((SECONDS - start))
      printf '\r\033[2K    %s %s%s %s(%dm%02ds)%s' \
        "${FRAMES[i++ % ${#FRAMES[@]}]}" "$label" "${detail:+  $detail}" \
        "$DIM" "$((secs / 60))" "$((secs % 60))" "$R"
      sleep 0.2
    done
    printf '\r\033[2K'
  else
    # Piped to a file or a log collector: no cursor to move, so say it once.
    note "$label…"
  fi
  wait "$pid" || rc=$?
  return "$rc"
}

warn() { # warn "headline" ["explanation" …]
  ISSUES=$((ISSUES + 1))
  printf '\n%s    %s %s%s\n' "$YEL" "$BULLET" "$1" "$R"
  shift
  local para
  for para in "$@"; do printf '%s\n' "$(printf '%s' "$para" | indent | indent)"; done
  printf '\n'
}

fail() { # fail "headline" ["what this means" …] — the last paragraph should say what to do
  printf '\n%s  %s %s%s\n\n' "$RED$B" "$CROSS" "$1" "$R" >&2
  shift
  local para
  for para in "$@"; do printf '%s\n\n' "$(printf '%s' "$para" | indent)" >&2; done
  # Tailored to how far it got: a bad command-line flag has left nothing behind
  # to reassure anyone about, and once containers exist, saying "nothing was
  # started" would be a lie.
  if $STARTED; then
    printf '  %sThe containers are still running, so nothing is lost — stop them with%s\n' "$DIM" "$R" >&2
    printf '  %scd %s && ./deploy/prod.sh down   — if you would rather start clean.%s\n\n' "$DIM" "$DIR" "$R" >&2
  elif ((STEP_NO > 0)); then
    printf '  %sNothing was left half-started — fix the above and run the installer again;%s\n' "$DIM" "$R" >&2
    printf '  %sit picks up wherever it got to.%s\n\n' "$DIM" "$R" >&2
  fi
  exit 1
}

# A failure the script did not anticipate still gets a useful message rather
# than a bare `set -e` exit with no output at all.
on_error() {
  local line=$1
  printf '\n%s  %s The installer stopped unexpectedly (line %s).%s\n\n' "$RED$B" "$CROSS" "$line" "$R" >&2
  printf '%s\n\n' "$(printf '%s' "That is a bug in the installer, not something you did wrong. The output
above shows what it was doing. Nothing dangerous is left behind: at worst
some containers are running, which you can stop with

    cd ${DIR:-<install dir>} && ./deploy/prod.sh down

Please report it, with the last few lines above:
    https://github.com/mneme-blog/mneme/issues" | indent)" >&2
  exit 1
}
trap 'on_error $LINENO' ERR

usage() {
  cat <<'EOF'
Guided installer for a self-hosted Mneme deployment.

  curl -fsSL https://raw.githubusercontent.com/mneme-blog/mneme/main/deploy/install.sh | bash

Options (pass them through the pipe with `bash -s -- --flag`):
  --dir PATH        where to install          (default: ~/mneme, /opt/mneme as root)
  --site ADDRESSES  addresses Caddy answers on (default: detected LAN IP + <host>.local)
  --backups PATH    backup archive directory  (default: ~/mneme-backups)
  --ref REF         branch or release tag to install               (default: main)
  --install-docker  install Docker via get.docker.com without asking
  --no-start        configure everything but do not start the stack
  --yes, -y         never prompt; accept every default
  --help, -h        this text

The same values can come from the environment, which is what to use from a
configuration manager: MNEME_DIR, MNEME_SITE_ADDRESS, MNEME_BACKUP_DIR,
MNEME_REF, MNEME_REPO_URL.
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --dir) DIR=${2:?--dir needs a path}; shift 2 ;;
    --site) SITE=${2:?--site needs at least one address}; shift 2 ;;
    --backups) BACKUPS=${2:?--backups needs a path}; shift 2 ;;
    --ref) REF=${2:?--ref needs a branch or tag}; shift 2 ;;
    --install-docker) INSTALL_DOCKER=true; shift ;;
    --no-start) START=false; shift ;;
    -y | --yes) ASSUME_YES=true; shift ;;
    -h | --help) usage ;;
    *) fail "Unknown option: $1" "Run the installer with --help to see what it accepts." ;;
  esac
done

# Only the first three steps run when the stack is not being started.
if ! $START; then TOTAL_STEPS=3; fi

# ── Asking questions ────────────────────────────────────────────────────────
# Prompts read the terminal directly, because stdin is the script itself when
# this is piped from curl. No terminal (CI, cron, a config manager) means no
# prompts: every question takes its default and the run is fully unattended.
TTY=""
if { exec 3<>/dev/tty; } 2>/dev/null; then TTY=yes; fi
INTERACTIVE=false
[[ -n $TTY ]] && ! $ASSUME_YES && INTERACTIVE=true

ask() { # ask "question" [y|n] -> exit status
  local question=$1 default=${2:-y} reply hint
  if ! $INTERACTIVE; then [[ $default == y ]]; return; fi
  [[ $default == y ]] && hint="[Y/n]" || hint="[y/N]"
  read -r -u 3 -p "    $question $hint " reply || reply=""
  reply=${reply:-$default}
  [[ ${reply,,} == y* ]]
}

prompt() { # prompt "label" "default" -> value on stdout
  local label=$1 default=$2 reply
  if ! $INTERACTIVE; then printf '%s' "$default"; return; fi
  read -r -u 3 -p "    $label [$default] " reply || reply=""
  printf '\n' >&2   # a blank line between the answer and what happens next
  printf '%s' "${reply:-$default}"
}

secret() { # URL- and env-file-safe: the Postgres password is embedded in DATABASE_URL
  if command -v openssl >/dev/null; then
    openssl rand -hex 24
  else
    LC_ALL=C tr -dc 'a-zA-Z0-9' </dev/urandom | head -c 48
  fi
}

set_env() { # set_env FILE KEY VALUE — replace the line, or append it
  local file=$1 key=$2 value=$3 tmp
  tmp=$(mktemp)
  KEY=$key VALUE=$value awk '
    $0 ~ "^" ENVIRON["KEY"] "=" { print ENVIRON["KEY"] "=" ENVIRON["VALUE"]; found = 1; next }
    { print }
    END { if (!found) print ENVIRON["KEY"] "=" ENVIRON["VALUE"] }
  ' "$file" >"$tmp"
  cat "$tmp" >"$file" # via cat, so the original 0600 mode survives
  rm -f "$tmp"
}

# ── Welcome ─────────────────────────────────────────────────────────────────
cat <<EOF

${B}Mneme — install your own encrypted journal server${R}

$(printf '%s' "This sets up Mneme on this machine: an end-to-end-encrypted journal that
you and the people you share the machine with can reach from any browser on
your network. Your entries are encrypted in the browser, so this server —
even though it is yours — only ever holds unreadable blobs.

It takes a few minutes, most of it downloading. Here is the plan:" | indent)

$(printf '%s' "1. Check this machine has what it needs (Docker, disk, free ports).
2. Fetch the Mneme source into a directory you choose.
3. Write a configuration file with freshly generated passwords.
4. Download the container images.
5. Start the stack: web server, relay, database, media store, speech-to-text.
6. Wait until it is genuinely serving, then tell you the address." | indent)
EOF
if $INTERACTIVE; then echo; fi
if ! ask "Ready to start?" y; then
  say ""
  say "No problem — nothing has been changed. Run this again whenever you like."
  exit 0
fi

# ── Step 1: the machine ─────────────────────────────────────────────────────
step "Checking this machine" "Everything Mneme needs is standard; this is just making sure it is here."

[[ $(uname -s) == Linux ]] || fail "This installer only supports Linux hosts." \
  "You are on $(uname -s). The Mneme stack itself runs anywhere Docker does, so it
works on macOS or Windows via Docker Desktop — it just needs setting up by hand." \
  "Follow docs/DEPLOYMENT.md instead:
    https://github.com/mneme-blog/mneme/blob/main/docs/DEPLOYMENT.md"

case $(uname -m) in
  x86_64 | amd64 | aarch64 | arm64) ok "Architecture $(uname -m) — published images cover it" ;;
  *) fail "No Mneme images are published for $(uname -m)." \
       "Ready-made images exist for x86_64 and arm64 (which covers Intel/AMD servers,
Apple silicon, and 64-bit Raspberry Pi OS). A 32-bit ARM system — an older Pi,
or a 64-bit Pi running the 32-bit OS — is not covered." \
       "If this is a 64-bit board, re-imaging with a 64-bit OS is the easy fix.
Otherwise you can build the images from source on the machine:
    git clone $REPO_URL mneme && cd mneme
    cp .env.prod.example .env.prod   # fill it in
    ./deploy/prod.sh up -d --build" ;;
esac

for tool in git curl; do
  command -v "$tool" >/dev/null || fail "\`$tool\` is not installed." \
    "The installer needs $tool to fetch Mneme." \
    "Install it and run this again:
    sudo apt install $tool      # Debian/Ubuntu
    sudo dnf install $tool      # Fedora/RHEL"
done
ok "git and curl are present"

SUDO=""
if [[ $EUID -ne 0 ]] && command -v sudo >/dev/null; then SUDO=sudo; fi

if ! command -v docker >/dev/null; then
  say ""
  say "Docker is not installed. Mneme runs as a handful of containers, so it is required."
  say ""
  say "The usual way to install it is Docker's own script, which adds Docker's package"
  say "repository and installs Docker Engine plus the Compose plugin. It needs root:"
  say ""
  say "    curl -fsSL https://get.docker.com | ${SUDO:+sudo }sh"
  say ""
  if $INSTALL_DOCKER || ask "Run that now?" n; then
    curl -fsSL https://get.docker.com | $SUDO sh ||
      fail "Docker's installer did not finish." \
        "The output above says why — usually an unsupported distribution or no network." \
        "Install Docker by hand and run this again:
    https://docs.docker.com/engine/install/"
    $SUDO systemctl enable --now docker 2>/dev/null || true
    if [[ $EUID -ne 0 ]]; then
      $SUDO usermod -aG docker "$USER" 2>/dev/null || true
    fi
    ok "Docker installed"
  else
    fail "Docker is required and was not installed." \
      "Install Docker Engine and its Compose plugin, then run this installer again:
    https://docs.docker.com/engine/install/" \
      "On Debian/Ubuntu the short version is:
    curl -fsSL https://get.docker.com | sh
    sudo systemctl enable --now docker
    sudo usermod -aG docker \"\$USER\"     # then log out and back in"
  fi
fi

docker compose version >/dev/null 2>&1 || fail "Docker is installed, but the Compose plugin is missing." \
  "Mneme is described as a Compose stack (\`docker compose up\`). The plugin is a
separate package on some distributions, and \`docker-compose\` v1 — the old
Python one — is not a substitute." \
  "Install it and run this again:
    sudo apt install docker-compose-plugin     # Debian/Ubuntu
    sudo dnf install docker-compose-plugin     # Fedora/RHEL
Check it with: docker compose version"

if ! docker info >/dev/null 2>&1; then
  if ! systemctl is-active --quiet docker 2>/dev/null; then
    fail "The Docker daemon is not running." \
      "Docker is installed but its service is stopped, so nothing can be started yet." \
      "Start it (and have it come back after a reboot), then run this again:
    ${SUDO:+sudo }systemctl enable --now docker"
  fi
  fail "This account is not allowed to talk to Docker." \
    "The daemon is running, but your user is not in the \`docker\` group — or it is,
and the membership has not taken effect in this shell yet (group changes only
apply to new login sessions)." \
    "Fix it, then log out and back in — or open a new SSH session — and run this
installer again:
    ${SUDO:+sudo }usermod -aG docker \"\$USER\"

In a hurry, \`sudo -i\` and re-running this as root also works (it will install
into /opt/mneme instead of your home directory)."
fi
ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo "") is running and reachable"

# Ports. Caddy publishes 80 and 443 on the host; a conflict is the single most
# common reason a first start fails, and the error Docker gives for it is not
# obvious, so check up front.
busy=""
if command -v ss >/dev/null; then
  busy=$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -oE ':(80|443)$' | tr -d ':' | sort -u | tr '\n' ' ' || true)
fi
if [[ -n ${busy// /} ]]; then
  # An existing Mneme install is the friendly case: it is about to be restarted.
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^mneme-prod-web'; then
    ok "Ports 80/443 are held by this machine's existing Mneme install (it will be restarted)"
  else
    warn "Ports ${busy% } are already in use by something else." \
      "Mneme's web server needs both 80 and 443 (HTTP redirects to HTTPS, and the
browser refuses to run the app without HTTPS). Whatever holds them — another
web server, a different container stack — will have to be stopped or moved,
or Mneme will fail to start in a moment." \
      "See what it is with:  ${SUDO:+sudo }ss -ltnp '( sport = :80 or sport = :443 )'"
  fi
else
  ok "Ports 80 and 443 are free"
fi

# Disk: images (~1.5 GB) + the speech model (~1.6 GB) + room for the database,
# media and backups to grow into.
disk_probe=${DIR:-$HOME}
while [[ -n $disk_probe && $disk_probe != / && ! -d $disk_probe ]]; do
  disk_probe=$(dirname "$disk_probe")
done
avail_kb=$(df -Pk "$disk_probe" 2>/dev/null | awk 'NR == 2 {print $4}' || true)
avail_kb=${avail_kb:-0}
avail_gb=$((avail_kb / 1024 / 1024))
if ((avail_kb == 0)); then
  note "Could not read the free space on $disk_probe — carrying on, but the install
      needs roughly 3 GB"
elif ((avail_gb < 4)); then
  fail "Only ${avail_gb} GB of disk space is free." \
    "The container images come to about 1.5 GB, the speech-to-text model another
1.6 GB, and then your journal, its media, and the rolling backups need room to
grow. Installing into this little space would fail partway through a download." \
    "Free up space (\`docker system prune\` often helps on a machine that has run
containers before), or pass --dir to install onto a bigger filesystem, then run
this again."
elif ((avail_gb < 10)); then
  warn "${avail_gb} GB of disk space free — enough to install, not much to grow into." \
    "Images and the speech model take about 3 GB of it. Keep an eye on it, and see
BACKUP_KEEP in .env.prod if the backup archives become the problem."
else
  ok "${avail_gb} GB disk space available"
fi

mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || true)
mem_kb=${mem_kb:-0}
if ((mem_kb > 0 && mem_kb < 2000000)); then
  warn "This machine has about $((mem_kb / 1024 / 1024)) GB of RAM." \
    "The journal itself is happy on very little. The bundled speech-to-text server
is the hungry part — roughly 2 GB while transcribing." \
    "It will install fine; if transcription later dies, either switch WHISPER_MODEL
in .env.prod to a smaller one (Systran/faster-whisper-small) or remove the
\`whisper\` and \`whisper-model\` services from docker-compose.prod.yml. Nothing
else in Mneme depends on them."
else
  ok "$((mem_kb / 1024 / 1024)) GB RAM"
fi

# ── Step 2: the source ──────────────────────────────────────────────────────
step "Fetching Mneme" "The compose files, the Caddy config and the management script live in a checkout — that directory is your deployment from now on."

if [[ -z $DIR ]]; then
  if [[ $EUID -eq 0 ]]; then DIR=/opt/mneme; else DIR="$HOME/mneme"; fi
  if $INTERACTIVE; then
    say ""
    say "This directory will hold the compose files, your configuration, and the"
    say "./deploy/prod.sh script you will use to manage the stack. Your journal data"
    say "itself lives in Docker volumes, not here."
    say ""
  fi
  DIR=$(prompt "Install directory?" "$DIR")
fi
DIR=${DIR/#\~/$HOME}

parent=$(dirname "$DIR")
if [[ ! -d $parent ]]; then
  mkdir -p "$parent" 2>/dev/null || fail "Cannot create $parent." \
    "The install directory's parent does not exist and could not be created — most
likely a permissions problem." \
    "Pick somewhere you can write with --dir, or create it first:
    ${SUDO:+sudo }mkdir -p $parent && ${SUDO:+sudo }chown \"\$USER\" $parent"
fi
[[ -w $parent || -w $DIR ]] || fail "No permission to write in $parent." \
  "The installer would have to create $DIR there, and this account cannot." \
  "Either install somewhere you own:
    curl -fsSL … | bash -s -- --dir \"\$HOME/mneme\"
or give yourself that directory:
    ${SUDO:+sudo }mkdir -p $DIR && ${SUDO:+sudo }chown \"\$USER\" $DIR"

if [[ -d $DIR/.git ]]; then
  say ""
  say "Found an existing checkout in $DIR — updating it in place."
  git -C "$DIR" fetch --depth 1 origin "$REF" --quiet 2>/dev/null ||
    fail "Could not fetch \`$REF\` from the Mneme repository." \
      "The checkout in $DIR exists, but the update could not be downloaded — usually
no network, a proxy in the way, or a --ref naming a branch or tag that does
not exist." \
      "Check the name and your connection, then run this again. To keep the version
you already have, add --no-start=false … or simply start the stack yourself:
    cd $DIR && ./deploy/prod.sh up -d"
  if git -C "$DIR" checkout --quiet FETCH_HEAD 2>/dev/null; then
    ok "Updated to the latest $REF"
  else
    warn "Kept the existing checkout." \
      "Git would not move $DIR onto $REF — usually because there are local changes
there. That is fine if they are yours and deliberate; the rest of the install
continues with the files as they are." \
      "To see them:  git -C $DIR status"
  fi
else
  if [[ -e $DIR ]]; then
    if [[ -f $DIR/docker-compose.prod.yml ]]; then
      warn "$DIR holds Mneme's files but is not a git checkout." \
        "It cannot be updated automatically, so the install continues with whatever is
there. That is usually a copied or extracted release." \
        "For automatic updates later, install into a fresh directory with --dir."
    else
      fail "$DIR already exists and does not look like Mneme." \
        "The installer will not write into a directory it did not create — there could
be anything in there." \
        "Choose an empty path:
    curl -fsSL … | bash -s -- --dir \"\$HOME/mneme\"
or move the existing directory aside first."
    fi
  else
    say ""
    say "Downloading the source (a shallow clone, a few MB)…"
    git clone --depth 1 --branch "$REF" "$REPO_URL" "$DIR" --quiet 2>/dev/null ||
      fail "Could not download Mneme from $REPO_URL." \
        "Nothing was written to $DIR. The usual causes: no internet connection on this
machine, a firewall or proxy blocking GitHub, or --ref naming a branch or tag
that does not exist (asked for: $REF)." \
        "Check with:  curl -fsSI https://github.com >/dev/null && echo 'GitHub reachable'"
    ok "Source in $DIR"
  fi
fi
cd "$DIR"

[[ -f docker-compose.prod.yml && -x deploy/prod.sh ]] || fail "$DIR is missing files Mneme needs." \
  "docker-compose.prod.yml or deploy/prod.sh is not there, so this is not a
complete Mneme checkout." \
  "Delete the directory and run the installer again, or clone it by hand:
    git clone $REPO_URL $DIR"

# ── Step 3: configuration ───────────────────────────────────────────────────
step "Writing configuration" "One file, .env.prod, holds this deployment's secrets and addresses. It is never committed and never leaves the machine."

ADMIN_TOKEN_SHOWN=""
if [[ -f .env.prod ]]; then
  ok "Keeping the existing .env.prod (your passwords and settings are untouched)"
  note "To start over from scratch, delete it and run this installer again."
else
  ip=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' | head -1)
  [[ -n $ip ]] || ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  [[ -n $ip ]] || ip=127.0.0.1
  host=$(hostname -s 2>/dev/null || echo mneme)
  default_site="$ip, $host.local"

  if [[ -z $SITE ]]; then
    if $INTERACTIVE; then
      say ""
      say "Which addresses will you open Mneme at? Caddy issues an HTTPS certificate"
      say "for exactly these names, and the app only works over HTTPS (the browser"
      say "withholds local storage and the camera otherwise). Comma-separated —"
      say "this machine's LAN address is usually what you want, and adding its"
      say ".local name means you can use either."
      say ""
    fi
    SITE=$(prompt "Addresses?" "$default_site")
  fi
  sni=$(printf '%s' "${SITE%%,*}" | tr -d '[:space:]')
  [[ -n $sni ]] || fail "No usable address in \"$SITE\"." \
    "Caddy needs at least one address to answer on and to issue a certificate for." \
    "Run again with something like:
    curl -fsSL … | bash -s -- --site \"192.168.1.10, ${host}.local\""

  if [[ -z $BACKUPS ]]; then
    if [[ $EUID -eq 0 ]]; then BACKUPS=/var/lib/mneme/backups; else BACKUPS="$HOME/mneme-backups"; fi
  fi
  BACKUPS=${BACKUPS/#\~/$HOME}

  umask 077
  cp .env.prod.example .env.prod
  ADMIN_TOKEN_SHOWN=$(secret)
  set_env .env.prod POSTGRES_PASSWORD "$(secret)"
  set_env .env.prod MINIO_ROOT_PASSWORD "$(secret)"
  set_env .env.prod ADMIN_TOKEN "$ADMIN_TOKEN_SHOWN"
  set_env .env.prod SITE_ADDRESS "$SITE"
  set_env .env.prod DEFAULT_SNI "$sni"
  set_env .env.prod BACKUP_HOST_DIR "$BACKUPS"
  umask 022

  ok "Wrote $DIR/.env.prod (readable only by you)"
  note "Generated a database password, media-store credentials, and an admin token"
  note "Site addresses: $SITE"
  note "Backups will land in $BACKUPS"
  note "Everything in that file is commented; it is the place to tune limits later"
fi

BACKUPS=$(grep '^BACKUP_HOST_DIR=' .env.prod | cut -d= -f2-)
if [[ -n $BACKUPS ]] && [[ ! -d $BACKUPS ]]; then
  mkdir -p "$BACKUPS" 2>/dev/null || $SUDO mkdir -p "$BACKUPS" 2>/dev/null ||
    fail "Cannot create the backup directory $BACKUPS." \
      "The relay writes a rolling archive of everyone's encrypted blobs there, so it
has to exist and be writable before the stack starts." \
      "Create it yourself, or point BACKUP_HOST_DIR in $DIR/.env.prod somewhere else:
    ${SUDO:+sudo }mkdir -p $BACKUPS && ${SUDO:+sudo }chown \"\$USER\" $BACKUPS"
fi

site_address=$(grep '^SITE_ADDRESS=' .env.prod | cut -d= -f2-)
first_address=$(printf '%s' "${site_address%%,*}" | tr -d '[:space:]')

if ! $START; then
  printf '\n%s%s Configured, not started (--no-start).%s\n\n' "$B" "$TICK" "$R"
  say "Have a look at $DIR/.env.prod, then bring it up with:"
  say ""
  say "    cd $DIR && ./deploy/prod.sh up -d"
  say ""
  exit 0
fi

# ── Step 4: images ──────────────────────────────────────────────────────────
step "Downloading the container images" "About 1.5 GB the first time, from GitHub's registry and Docker Hub. Later runs only fetch what changed."

# How many distinct images the stack needs, so the one progress line can count
# them off. Best-effort: if compose cannot answer, the line just omits the count.
PULL_TOTAL=$(./deploy/prod.sh config --images 2>/dev/null | sort -u | grep -c . || true)
[[ ${PULL_TOTAL:-0} -gt 0 ]] || PULL_TOTAL=""

pull_detail() { # a suffix for the spinner: images finished so far
  [[ -n $PULL_TOTAL ]] || return 0
  local done_n
  done_n=$(grep -c ' Pulled *$' "$SPIN_LOG" 2>/dev/null || true)
  printf '%d/%d images' "${done_n:-0}" "$PULL_TOTAL"
}

SPIN_DETAIL=pull_detail
if ! spin "Downloading images" ./deploy/prod.sh pull; then
  SPIN_DETAIL=""
  printf '\n'
  tail -n 20 "$SPIN_LOG" | indent || true
  # A registry refusal is not a connectivity problem and the generic advice
  # sends people looking in the wrong place, so it is named separately.
  if grep -qE 'denied|unauthorized|not found|manifest unknown' "$SPIN_LOG"; then
    fail "The image registry refused the download." \
      "This is not your network: ghcr.io answered, and said no. Either the images
for this version have not been published yet, or they are private, or the tag
in deploy/version.env names something that does not exist." \
      "You can build them from this checkout instead — it takes longer, but needs
nothing from the registry:

    cd $DIR && ./deploy/prod.sh up -d --build

If you did not expect this, please report it with the lines above:
    https://github.com/mneme-blog/mneme/issues"
  fi
  fail "Could not download the container images." \
    "The lines above name the image that failed. Common causes: no internet
access from this machine, a proxy or firewall blocking ghcr.io or Docker Hub,
or a full disk part-way through." \
    "Check connectivity and space, then run this installer again — completed
downloads are cached, so it resumes rather than starting over:
    docker pull ghcr.io/mneme-blog/mneme-server:latest
    df -h $DIR"
fi
SPIN_DETAIL=""
ok "Images downloaded${PULL_TOTAL:+ ($PULL_TOTAL images)}"

# ── Step 5: start ───────────────────────────────────────────────────────────
step "Starting the stack" "Five services: Caddy (HTTPS), the relay, Postgres, MinIO for media, and the speech-to-text server."

if ! ./deploy/prod.sh up -d; then
  printf '\n'
  ./deploy/prod.sh ps 2>/dev/null | indent || true
  fail "The stack did not start." \
    "The output above is Docker's own. Two causes account for most of it:

  ${BULLET} \"port is already allocated\" — something else on this machine holds 80
    or 443. Find it with: ${SUDO:+sudo }ss -ltnp '( sport = :80 or sport = :443 )'
  ${BULLET} a container exits immediately — see why with:
        cd $DIR && ./deploy/prod.sh logs server" \
    "Once it is resolved, run this installer again."
fi
STARTED=true
ok "Containers started"

# ── Step 6: wait for it to actually serve ───────────────────────────────────
step "Waiting for Mneme to come up" "The database has to migrate and the relay has to report ready — usually under a minute."

printf '    '
ready=false
for _ in $(seq 1 60); do
  if curl -fsk --max-time 3 "$READY_URL" >/dev/null 2>&1; then
    ready=true
    break
  fi
  printf '.'
  sleep 3
done
printf '\n'

if ! $ready; then
  printf '\n'
  ./deploy/prod.sh ps 2>/dev/null | indent || true
  printf '\n    %sLast lines from the relay:%s\n' "$DIM" "$R"
  ./deploy/prod.sh logs --tail 15 server 2>/dev/null | indent || true
  fail "Mneme did not answer within three minutes." \
    "The containers are running but the app is not serving yet. The state table and
relay log above usually say why:

  ${BULLET} \"connection refused\" from Postgres — the database is still starting on a
    slow disk. Give it a minute and check again with the command below.
  ${BULLET} the \`web\` container restarting — Caddy could not bind 80/443, or the
    SITE_ADDRESS in .env.prod is not an address this machine has.
  ${BULLET} a migration error — please report that one, it is a bug." \
    "Check whether it came up after all:
    curl -k $READY_URL
    cd $DIR && ./deploy/prod.sh ps
    cd $DIR && ./deploy/prod.sh logs -f server"
fi
ok "The relay is ready and serving"

# ── Done ────────────────────────────────────────────────────────────────────
printf '\n%s%s Mneme is running.%s\n\n' "$B$GRN" "$TICK" "$R"

say "Open it at         ${B}https://$first_address/mneme/${R}"
say "Operator dashboard https://$first_address/mneme/admin"
if [[ -n $ADMIN_TOKEN_SHOWN ]]; then
  say "Dashboard token    ${B}$ADMIN_TOKEN_SHOWN${R}"
  say "                   (this is the only time it is printed; it is also the"
  say "                   ADMIN_TOKEN line in $DIR/.env.prod)"
else
  say "Dashboard token    the ADMIN_TOKEN line in $DIR/.env.prod"
fi
say "Backups            $BACKUPS"
say "Manage it with     cd $DIR && ./deploy/prod.sh ps | logs -f server | down"

cat <<EOF

$(printf '%s' "${B}Two things will surprise you on first visit, and both are fine.${R}" | indent)

$(printf '%s' "${BULLET} ${B}Your browser will warn about the certificate.${R} Mneme issues its own, because
  a machine on your LAN has no public name to get a real one for. Click through
  the warning to use the app. To silence it for good — and it is required if you
  want to install Mneme as an app on a phone — copy the certificate authority
  out and trust it on each device:

      cd $DIR && ./deploy/prod.sh cp web:/data/caddy/pki/authorities/local/root.crt .

${BULLET} ${B}Transcription says it has no model for a while.${R} The speech-to-text server is
  downloading one, about 1.6 GB, once. Everything else works meanwhile.

      cd $DIR && ./deploy/prod.sh logs -f whisper-model" | indent)

$(printf '%s' "${B}${YEL}And the one rule with no way around it:${R} when you open Mneme it gives you a
12-word recovery phrase. That phrase is your account and the only key to your
entries. It is generated in your browser and never reaches this server, so
nobody here — not even you, running the machine — can reset or recover it.
${B}Write it down on paper.${R} Lose it and the journal is gone for good." | indent)

$(printf '%s' "Where to go next:
  ${BULLET} $DIR/docs/DEPLOYMENT.md  — what you just installed, and how to change it
  ${BULLET} $DIR/docs/MAINTENANCE.md — backups, restore, upgrades, troubleshooting" | indent)
EOF

if ((ISSUES > 0)); then
  printf '\n%s  %d thing%s above was worth noting — scroll up if you skipped past it.%s\n' \
    "$YEL" "$ISSUES" "$( ((ISSUES == 1)) || echo s)" "$R"
fi
printf '\n'
