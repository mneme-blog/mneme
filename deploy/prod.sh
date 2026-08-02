#!/usr/bin/env bash
# Wrapper around docker compose for the production stack: pins the compose
# file and the .env.prod env file so every invocation is consistent.
#
#   ./deploy/prod.sh up -d --build
#   ./deploy/prod.sh ps
#   ./deploy/prod.sh logs -f server
#   ./deploy/prod.sh exec server /journald backup        # backup right now
#   ./deploy/prod.sh exec server /journald list-backups
#   ./deploy/prod.sh down
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env.prod ]]; then
  echo "error: .env.prod not found — copy .env.prod.example and fill it in" >&2
  exit 1
fi

# Which images the stack runs. deploy/version.env is owned by the updater agent
# (deploy/updater/mneme-updater.sh): it rewrites the pin on every apply and
# rollback, so `prod.sh up -d` after an update brings up the version that was
# actually installed rather than silently reverting to :latest. Absent — the
# normal state before the first one-click update — the compose defaults apply.
if [[ -f deploy/version.env ]]; then
  set -a
  # shellcheck disable=SC1091  # generated at runtime; nothing to lint at rest
  source deploy/version.env
  set +a
fi

# Stamp the source version into the server image at build time so the admin
# dashboard can report it and compare against the latest GitHub release. Only
# meaningful for `--build`; pulled images carry the version stamped at release.
export MNEME_VERSION="${MNEME_VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"

exec docker compose -f docker-compose.prod.yml --env-file .env.prod "$@"
