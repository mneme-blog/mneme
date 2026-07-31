# Relay HTTP API

The relay (`journald`) is a small JSON-over-HTTP service. Binary fields are **standard base64**
(Go `StdEncoding`); `owner_id` / `device_id` are **base64url without padding** (`sha256(pubkey)`).
Authenticated routes require `Authorization: Bearer <token>` and are strictly scoped to the session's
`owner_id`. Base URL in dev: `http://localhost:8080` (client override: `VITE_RELAY_URL`).

See [ARCHITECTURE.md §6](./ARCHITECTURE.md) for the call sequence and [SECURITY.md](./SECURITY.md) for
the auth model.

---

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/healthz` | – | liveness |
| GET | `/readyz` | – | readiness (pings Postgres) |
| POST | `/v1/register` | – | create owner (TOFU) + bind a device |
| POST | `/v1/auth/challenge` | – | random challenge for a device |
| POST | `/v1/auth/verify` | – | sign the challenge → session token |
| POST | `/v1/sync/push` | ✅ | upload encrypted entry blobs (LWW) |
| POST | `/v1/sync/pull` | ✅ | download entries changed since a cursor |
| GET | `/v1/reminders` | ✅ | list reminders |
| PUT | `/v1/reminders` | ✅ | create / reschedule a reminder |
| DELETE | `/v1/reminders/{id}` | ✅ | delete a reminder |
| PUT | `/v1/media/{id}/chunks/{n}` | ✅ | upload one encrypted media chunk (raw body) |
| POST | `/v1/media/{id}/complete` | ✅ | finalize an upload (record chunk count) |
| GET | `/v1/media/{id}` | ✅ | media metadata (ciphertext bytes, chunk count) |
| GET | `/v1/media/{id}/chunks/{n}` | ✅ | download one encrypted media chunk |
| DELETE | `/v1/media/{id}` | ✅ | delete one media object (index + chunks) |
| DELETE | `/v1/account` | ✅ | wipe the owner entirely (phrase rotation) |
| GET | `/admin` | – | admin dashboard page (404 unless `ADMIN_TOKEN` is set) |
| GET | `/admin/stats` | 🔑 | aggregate stats JSON (`Bearer <ADMIN_TOKEN>`) |
| GET | `/admin/version` | 🔑 | running build vs. latest GitHub release |
| DELETE | `/admin/vaults/{id}` | 🔑 | operator vault wipe (requires `{"confirm":"delete"}` body) |
| POST | `/admin/owners/{id}/approve` | 🔑 | approve a pending vault (`REQUIRE_APPROVAL`) |
| POST | `/admin/owners/{id}/reject` | 🔑 | reject / revoke a vault (immediate) |
| GET | `/admin/backups` | 🔑 | backup service status + stored archive listing |
| POST | `/admin/backups` | 🔑 | trigger a backup now (202, runs detached) |
| GET | `/admin/backups/{name}` | 🔑 | download one archive (gzip tar) |
| DELETE | `/admin/backups/{name}` | 🔑 | remove one stored archive |
| POST | `/admin/backups/{name}/restore` | 🔑 | restore from an archive (requires `{"confirm":"restore"}` body) |

Errors are `{ "error": "message" }` with an appropriate status (400/401/404/500). CORS preflight
(`OPTIONS`) is answered for configured origins (`CORS_ORIGINS`).

---

## Auth

### `POST /v1/register`
Two signatures, both Ed25519:

- **device**, over `"mneme:register:" || ownerPub || devicePub` — proves possession of the device key.
- **owner**, over `"mneme:bind-device:v1:" || ownerPub || ownerSignPub || devicePub` — proves
  possession of the **seed**, and is what authorizes attaching this device to this vault. The client
  derives `ownerSignPub` from the seed (`HKDF info="identity-sign"` → Ed25519).

Trust-on-first-use now applies only to **creating** a vault: the relay pins `owner_sign_pubkey` when
the owner row is created, and every later registration for that owner must be signed by the same key.
Knowing a vault's `owner_pubkey` — which is a *public* key and not treated as a secret — therefore
grants nothing. Requests that fail this check get a single, undifferentiated `401` that does not
reveal whether the owner exists.

Owners registered before this check existed have no pinned key. For them the relay adopts the
presented key **once**, and only when the request comes from a device already bound to that owner
(device keys are seed-derived, so an honest client always presents one). Both signatures are verified
before any of this.

`approval_hint` is optional — a short `[a-z0-9-]{0,32}` code the client derives from the seed (e.g.
`amber-otter-07`), only used when the relay runs with `REQUIRE_APPROVAL` (see "Admin"); it is not a
secret and never free text.
```jsonc
// request
{ "owner_pubkey":      "<base64 X25519, 32B>",
  "device_pubkey":     "<base64 Ed25519, 32B>",
  "signature":         "<base64 Ed25519 sig>",
  "owner_sign_pubkey": "<base64 Ed25519, 32B>",
  "owner_signature":   "<base64 Ed25519 sig>",
  "approval_hint":     "amber-otter-07" }   // optional
// 200
{ "owner_id": "<base64url>", "device_id": "<base64url>",
  "status": "approved" }                    // "pending" on a REQUIRE_APPROVAL relay
// 401 — registration is not authorized for this owner
```
> **Upgrade order:** the relay rejects unknown JSON fields, so upgrade the **relay before the
> client** — a new client against an old relay gets a `400` at sign-in. That is deliberate: failing
> loudly beats silently falling back to the unauthorized binding.
On a `REQUIRE_APPROVAL` relay a new owner is `pending`: `/v1/auth/verify` then returns `403` (after
the signature verifies) and every authenticated call `403`s until the operator approves the vault.

### `POST /v1/auth/challenge`
```jsonc
{ "device_id": "<base64url>" }
// 200 — challenge is single-use, expires in 2 minutes
{ "challenge": "<base64>", "expires_at": "RFC3339" }
```

### `POST /v1/auth/verify`
```jsonc
{ "device_id": "<base64url>",
  "challenge": "<base64 from /challenge>",
  "signature": "<base64 Ed25519 sig over challenge bytes>" }
// 200 — token TTL defaults to 24h; server stores only sha256(token)
{ "token": "<opaque>", "owner_id": "<base64url>", "expires_at": "RFC3339" }
```

---

## Sync

### `POST /v1/sync/push`
Last-write-wins per entry on `lww_clock`. The server treats `ciphertext` as opaque bytes.
```jsonc
{ "entries": [
    { "entry_id": "<random hex>",
      "lww_clock": 1717900000000,
      "ciphertext": "<base64 of [version][nonce][ct+tag]>",
      "deleted": false }
] }
// 200 — applied=false means a not-newer clock was ignored
{ "results": [ { "entry_id": "...", "applied": true } ] }
// 413 — more than 500 entries in one batch
```
At most **500 entries per request** (mirroring `pull`'s limit). The 32 MiB body cap alone doesn't
bound the count, and each entry is a separate round-trip in a loop, so a batch of tiny entries would
otherwise become an unbounded burst of sequential writes. Clients split larger batches.

### `POST /v1/sync/pull`
```jsonc
{ "since": 0, "limit": 500 }
// 200 — cursor = max seq returned; when cursor == since you're caught up
{ "entries": [
    { "entry_id": "...", "lww_clock": 1717900000000,
      "ciphertext": "<base64>", "deleted": false, "seq": 42 }
  ],
  "cursor": 42,
  "more": false }
```

---

## Reminders

`fire_at` is **cleartext** (an accepted leak — the scheduler needs it; the entry stays encrypted).

```jsonc
// PUT /v1/reminders
{ "reminder_id": "...", "fire_at": "RFC3339" }   // 200 { "reminder_id": "..." }

// GET /v1/reminders  →  200
{ "reminders": [ { "reminder_id": "...", "fire_at": "RFC3339", "dispatched": false } ] }

// DELETE /v1/reminders/{id}  →  204 No Content
```

---

## Media

Server-relayed, chunked, client-encrypted (§6/§10 step 5; see `internal/blobs`). The client splits
a recording into ~1 MiB plaintext chunks, seals each one independently under the media key
(`[version][nonce:24][ct+tag]`, AAD binds media id + chunk position), and uploads them one by one.
The relay streams chunks to S3/MinIO under `media/{owner_id}/{media_id}/{n}` and stores only
`(media_id, bytes, chunks)` in Postgres. Which entry a media object belongs to — and its mime type,
duration, and plaintext size — travels inside the *encrypted entry body* (`attachments` list), so
the relay learns nothing beyond the random id and ciphertext sizes.

```jsonc
// PUT /v1/media/{id}/chunks/{n}    body: raw octet-stream (one encrypted chunk, ≤2 MiB)
{ "media_id": "…", "chunk": 0 }

// POST /v1/media/{id}/complete
{ "chunks": 2, "bytes": 1049892 }       // ciphertext totals; → { "media_id": "…" }

// GET /v1/media/{id}  →  200
{ "media_id": "…", "bytes": 1049892, "chunks": 2 }

// GET /v1/media/{id}/chunks/{n}  →  200 octet-stream (the encrypted chunk)

// DELETE /v1/media/{id}  →  204
```

`{id}` must match `[A-Za-z0-9_-]{16,64}` (clients use random 128-bit hex — never date-encoded).
Without `S3_ENDPOINT` configured the media endpoints answer `503`; clients keep recordings queued
locally and retry. Re-uploading the same media id is idempotent.

`DELETE` removes the Postgres index row first, then best-effort-sweeps the **whole
`media/{owner}/{id}/` object prefix** (a failure there only orphans ciphertext nothing references).
Sweeping the prefix rather than the indexed chunk range matters: a chunk that was uploaded but never
`complete`d has no index row, so index-driven cleanup could never reach it and it survived both media
deletion and full account deletion. Object storage, not the index, is the authority on what exists.
For the same reason a `DELETE` for an id with no index row still sweeps its chunks.

It is **idempotent** — deleting an unknown or already-deleted id answers `204` — because clients
queue deletions while offline (the local `media_tombstones` table) and retry until acknowledged.

---

## Account

### `DELETE /v1/account` → `204 No Content`

Deletes **everything** stored for the authenticated owner: entry blobs, the media index, **every
object under the `media/{owner}/` prefix** — including chunks from uploads that were never finalized,
which no index row covers — reminders, push subscriptions, devices, and all sessions (including the
one making the request). There is no request body and no undo.

This is the server half of **recovery-phrase rotation** (`apps/client/src/sync/rotate.ts`): because
`owner_id` and all keys are derived from the mnemonic, a phrase can't be changed in place — the
client derives a fresh identity from a new phrase, re-encrypts and re-pushes the whole vault as a
brand-new owner, and only then calls this endpoint with the *old* session token. Afterwards the old
phrase still passes TOFU registration (it's just a keypair) but opens an empty vault.

---

## Admin

Disabled by default: every `/admin` path is a plain 404 until the `ADMIN_TOKEN` environment variable
is set. The admin surface is for the **operator** and shows **aggregates and storage metadata only** —
exactly what the relay already stores as accepted metadata (see SECURITY.md). It cannot show content
or identities, because the data to do so does not exist server-side.

### `GET /admin`

The dashboard page (self-contained HTML, no external assets). The page asks for the admin token in
the browser and calls `/admin/stats` with it; the token is kept in `sessionStorage` only.

### `GET /admin/stats` → `200`

Requires `Authorization: Bearer <ADMIN_TOKEN>` (constant-time compared; wrong token → 401).

```json
{
  "totals":  { "vaults": 4, "devices": 6, "records": 120, "record_bytes": 51234,
               "media_objects": 9, "media_bytes": 20801466 },
  "vaults":  [ { "vault": "GGnnHixG…", "owner_id": "…", "status": "approved",
                 "approval_hint": "amber-otter-07", "created_at": "…", "devices": 1,
                 "records": 4, "record_bytes": 6798,
                 "media_objects": 6, "media_bytes": 16599319, "last_activity": "…" } ],
  "daily":   [ { "day": "2026-06-12", "counts": { "requests": 23, "requests_failed": 2,
                 "records_created": 2, "media_uploaded": 1, "media_bytes": 1048576,
                 "vaults_created": 3, "vaults_deleted": 1 } } ],
  "require_approval": false,
  "runtime": { "started_at": "…", "uptime_seconds": 45, "requests": 23,
               "failed_4xx": 1, "failed_5xx": 1, "avg_latency_ms": 2.3, "max_latency_ms": 10.1 }
}
```

- `vaults` — per-vault storage footprint from the existing bookkeeping tables. `vault` is a
  *truncated* opaque pubkey hash (pseudonymous by construction, never an identity).
- `daily` — the last 30 days from the `usage_daily` table, which has **no owner column by design**:
  daily activity can never be attributed to a vault. Counters are buffered in memory and flushed
  every 30 s (plus once on graceful shutdown), so up to 30 s of counts can be lost on a crash.
  Only `/v1/*` traffic counts as a request — health probes and admin polling are excluded.
- `runtime` — since-process-start health figures (kept in memory, reset on restart).

Honest limits of an E2EE relay: "records" are encrypted oplog rows — entries, templates, journal
metadata and AI-settings records are **indistinguishable** on purpose (the record kind lives inside
the ciphertext). "Journals created" is not measurable at all — journal metadata syncs under a random
wire id with the journal's identity inside the ciphertext — and media kinds (video/audio/image/file)
are unknowable — the mime type never reaches the relay.

### `GET /admin/version` → `200`

Requires `Authorization: Bearer <ADMIN_TOKEN>`. Reports the running build and — unless disabled —
the newest published GitHub release, so the dashboard can show a "newer version available" banner.
It is **informational only**: the relay never downloads or applies anything; upgrading is a host-side
operation the operator runs (see deploy/README.md).

```json
{
  "current": "v0.2.1",
  "latest": "v0.3.0",
  "update_available": true,
  "html_url": "https://github.com/plasticparticle/mneme/releases/tag/v0.3.0",
  "name": "v0.3.0",
  "published_at": "2026-07-01T12:00:00Z",
  "notes": "…release body (truncated)…",
  "checked_at": "2026-07-06T09:00:00Z"
}
```

- `current` is stamped into the binary at build time (`-ldflags -X main.version`); source builds
  report `dev`, and a non-semver `current` is never flagged as out-of-date (`update_available:false`).
- The relay queries `api.github.com` at most once per hour (cached; a failed check falls back to the
  last good result with an `error` field). This is the relay's **only** outbound call.
- Set `UPDATE_CHECK=off` (or `false`/`0`) to disable it entirely for air-gapped deployments — the
  endpoint then returns `{"current": "…", "disabled": true}` and makes no outbound request.

### `DELETE /admin/vaults/{id}` → `204 No Content`

Operator-initiated vault wipe (e.g. reclaiming storage from an abandoned vault). `{id}` is the full
`owner_id` from `/admin/stats`. The body **must** be `{"confirm":"delete"}` — the typed confirmation
is enforced server-side (400 without it), not just in the dashboard UI, so a stray request with a
valid admin token cannot destroy a vault. 404 when the vault doesn't exist (or is already gone).

Destroys exactly what self-service `DELETE /v1/account` destroys: entry blobs, the media index and
its S3 chunks, reminders, push subscriptions, devices, and sessions. It does **not** reach into any
device's local copy — the relay has no access to clients, by design — and the same recovery phrase
can re-register afterwards as an empty vault (TOFU). The dashboard exposes this per vault row behind
a type-"delete" modal.

### `POST /admin/owners/{id}/approve` · `POST /admin/owners/{id}/reject` → `204 No Content`

Operator approval controls, meaningful when the relay runs with **`REQUIRE_APPROVAL=true`** (an
opt-in, default off). With it on, a newly registered owner is created **`pending`** and cannot obtain
a session (nor make any authenticated call) until approved. `{id}` is the full `owner_id`;
`/admin/stats` reports each vault's `status` and `approval_hint`, and `require_approval` at the top.

- **approve** sets the vault to `approved` — it can now authenticate normally.
- **reject** sets it to `rejected`. Enforcement is **immediate**: the auth middleware reads live
  status on every request, so an already-signed-in owner is cut off on its next call (not when its
  session expires). Rejecting keeps the vault's (opaque) data; use `DELETE /admin/vaults/{id}` to wipe.

404 when the owner doesn't exist. Owners that already existed when `REQUIRE_APPROVAL` was first
enabled are grandfathered to `approved` (migration `0003`), so turning it on never locks anyone out.

Why this exists: the mnemonic is the account (no signup), so an open relay lets anyone store their own
(encrypted) journals on it. `REQUIRE_APPROVAL` makes the relay single-tenant (or hand-picked) at the
layer that matters — the API — rather than wrapping the whole site in a network auth gate, which
would break the PWA's install and offline sync. The `approval_hint` (a memorable `[a-z0-9-]` code the
client derives from the seed, e.g. `amber-otter-07`) lets the operator tell one pending vault from
another; the user reads it off their in-app "pending approval" screen. See SECURITY.md.

Authorization note: vault deletion is two strictly separated capabilities. A **user session** can
only ever delete its own vault — `DELETE /v1/account` takes no vault id; the owner comes from the
authenticated session. The **admin token** is required to delete by id; without it, `/admin/vaults/*`
answers 401 (or 404 when the admin surface is disabled) before any lookup happens.

### Backups & disaster recovery

Enabled when `BACKUP_DIR` is set (otherwise the endpoints answer 503, and the scheduled worker is
off). A backup is a single gzipped tar of **every vault's opaque ciphertext** — the bookkeeping tables
as NDJSON plus the client-encrypted media chunks. It contains **no keys and no plaintext** (the relay
never has any), so an archive is exactly as sensitive as the relay's own storage and changes nothing
about the E2EE guarantees (see SECURITY.md §6). `sessions` and `auth_challenges` are deliberately
excluded — they are short-lived secrets that must not be resurrected from an old archive.

Layout: `manifest.json` (format version, timestamp, schema version, row counts), `db/*.ndjson` (one
file per table, base64 for `bytea` columns), `media/<owner_id>/<media_id>/<n>` (raw chunk bytes).

`GET /admin/backups` → `200` — service status plus the stored archive listing:

```json
{
  "enabled": true, "dir": "/backups", "keep": 7, "running": false,
  "last_name": "mneme-backup-20260614T203954Z.tar.gz", "last_at": "2026-06-14T20:39:54Z",
  "last_error": "",
  "backups": [ { "name": "mneme-backup-20260614T203954Z.tar.gz", "bytes": 1003,
                 "created_at": "2026-06-14T20:39:54Z" } ],
  "total_bytes": 1003
}
```

`POST /admin/backups` → `202` — start a backup. The write can be slow on a large media set, so it
runs **detached**; poll `GET /admin/backups` for the new archive (or `last_error`). 409 if one is
already running, 503 if backups are disabled. Archives are written to a `.partial` file and renamed
on success, so a crash mid-write never leaves a truncated archive that looks complete. The newest
`BACKUP_KEEP` archives are retained (0 = keep all).

`GET /admin/backups/{name}` → `200` (`application/gzip`) — download one archive. `{name}` must be a
literal archive filename (`^mneme-backup-\d{8}T\d{6}Z\.tar\.gz$`); anything else → 400, the security
boundary against path traversal. The dashboard downloads via an authenticated fetch (never a token in
the URL — admin paths are logged).

`DELETE /admin/backups/{name}` → `204` — remove one archive (does not touch vault data).

`POST /admin/backups/{name}/restore` → `200` — **disaster recovery**. Body **must** be
`{"confirm":"restore"}` (enforced server-side, 400 without it). This **replaces all relay data** with
the archive's contents in one transaction (truncate-and-replay; a failure leaves the existing data
untouched), then re-uploads the media chunks to object storage. The response echoes the restored
manifest counts. Sessions are cleared, so every device re-authenticates on next sync. An archive whose
schema version is newer than the running binary is refused — upgrade `journald` first.

The **recommended** path for real DR is the CLI (`journald restore <archive>`): it runs against a
stopped or freshly-provisioned server, which is the usual state when recovering. See README/§Commands.

---

## Quick curl

```bash
curl -s localhost:8080/healthz
curl -s localhost:8080/readyz
```

Registration/auth need real Ed25519 signatures — the easiest way to exercise the full flow is the
client integration script:

```bash
pnpm --filter client exec tsx scripts/integration.ts
```
