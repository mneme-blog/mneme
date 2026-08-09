# Contributing

A practical guide to working in this repo. For *what* to build and *in what order*, the
authority is [`../CLAUDE.md`](../CLAUDE.md) (§10 roadmap, §3 locked decisions). For how things fit
together, see [ARCHITECTURE.md](./ARCHITECTURE.md); for the security rules, [SECURITY.md](./SECURITY.md).

---

## Prerequisites

- **Node 22+** and **pnpm 11** (`corepack enable` sorts it out)
- **Go 1.25** (match `server/go.mod`; the Dockerfile pins the same)
- **Docker** (for Postgres + MinIO via `docker-compose.yml`)

## Setup

```bash
corepack enable
pnpm install
(cd server && go mod download)
```

## Running everything

```bash
docker compose up -d      # Postgres + MinIO + relay (:8080)
pnpm dev                  # client dev server (:5173), points at :8080 by default
```

Override the relay URL with `VITE_RELAY_URL`. Identity is in-memory only, so you re-enter the
mnemonic on each cold start (the seed/keys are never persisted); your entries persist locally in a
per-owner wa-sqlite DB on OPFS and reappear after unlock.

## Quality gates

```bash
# Client
pnpm --filter client typecheck     # tsc --noEmit, strict
pnpm --filter client build         # typecheck + production build

# Server
cd server
gofmt -l .                         # must print nothing
go vet ./...
go test ./...                      # unit tests, no DB needed

# The client regression suite (no relay/Chrome needed; same set CI runs)
pnpm --filter client check

# Server end-to-end (needs Postgres up, and a DEDICATED test database — the
# suite truncates everything it finds; it refuses to run against a database
# whose name doesn't contain "test")
docker compose up -d postgres
docker compose exec postgres createdb -U journal journal_test   # once
TEST_DATABASE_URL=postgres://journal:journal_dev@localhost:5432/journal_test?sslmode=disable \
  go test -tags e2e ./e2e/...

# Full client↔relay round-trips (relay must be running; `exec` runs from
# apps/client/, so the path is scripts/…, not apps/client/scripts/…)
pnpm --filter client exec tsx scripts/integration.ts          # register → auth → encrypt → push/pull
pnpm --filter client exec tsx scripts/templates-roundtrip.ts  # templates through the entry oplog
```

`pnpm --filter client check` runs every repro script that needs no external
service (the list lives in `apps/client/scripts/check-all.mjs`). The
relay-dependent ones (`integration`, `templates-roundtrip`,
`interview-types-roundtrip`, `journal-sync-roundtrip`, `ai-roundtrip`) and
`film-e2e.mjs` (real Chrome + WebCodecs) stay manual. Each feature's CLAUDE.md
§0 note names its check.

CI (`.github/workflows/ci.yml`) runs on every PR: gofmt + go vet + go build +
go test + the Postgres e2e suite, shellcheck + the updater regression tests,
and the client typecheck + build + regression suite. There is no ESLint/
Prettier config yet — strict `tsc` (now covering `scripts/` too) is the TS
gate; adding ESLint/Prettier is welcome.

## Conventions (from CLAUDE.md §11)

- **English** for all code, comments, variables, commits, and API. Only `CLAUDE.md` (§1–§12) is German.
- **TypeScript is `strict`.** Go is `gofmt` + (eventually) `golangci-lint`. Rust (future) is `clippy`.
- **Migrations are forward-only** and versioned (`NNNN_name.sql`), embedded into the binary.
- **Never commit secrets.** The `_dev` credentials in compose are for local use only.
- **Every new ciphertext path includes the version byte** (`[version][nonce][ct+tag]`).
- **Entry ids are random**, never timestamp/ULID-encoded (leak-guard — see SECURITY.md §6.10).

## Security-sensitive changes

If you touch crypto, auth, sync, or anything that crosses the client↔server boundary:
- Re-read [SECURITY.md](./SECURITY.md) (threat model + attack vectors) and
  [ENCRYPTION.md](./ENCRYPTION.md) (the primitives). Keep both honest — if a change opens or closes a
  vector, or alters a primitive/envelope, update the relevant doc.
- Keys must never reach the DOM, logs, or the server. The server must never need to decrypt.
- Run the `e2e` test and the client integration script.

## Where things live (client)

| You want to change… | Look in |
|---|---|
| Colours / fonts / spacing | `apps/client/src/styles/tokens.css` |
| A screen's layout | `apps/client/src/screens/` |
| Shared UI bits (buttons, icons, chips, search, templates, lightbox) | `apps/client/src/ui/` |
| Crypto (keys, AEAD, mnemonic, chunked media) | `apps/client/src/crypto/` |
| The local database (schema, queries, OPFS worker) | `apps/client/src/db/` (migrations are forward-only) |
| The editor (TipTap, slash palette, inline media nodes) | `apps/client/src/editor/` |
| Sync (relay client, auth, push/pull, media, rotation) | `apps/client/src/sync/` |
| App state / sync loop / identity / outboxes | `apps/client/src/state/data.tsx` |

## Where things live (server)

| You want to change… | Look in |
|---|---|
| An HTTP handler | `server/internal/api/` |
| A SQL query | `server/internal/store/store.go` |
| The schema | `server/migrations/` (add a new forward-only file) |
| Config / env | `server/internal/config/config.go` |

## Commits & branches

Conventional, imperative commit subjects. The project has been committing to `main`; if you prefer a
PR workflow, branch first. Keep commits scoped and explain *why* in the body when it isn't obvious.
