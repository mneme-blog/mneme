# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Note:** Sections §1–§12 below are the original **decision document** — the **source of truth**
> for architecture. This §0 preamble is the operating guide; if it ever conflicts with §1–§12,
> §1–§12 win on decisions.

---

## 0. Operating Guide (read first)

### Current state
The directory is named `mneme`; the design doc calls the product "journal" — treat them as the same
project. Scaffolded so far:
- **`apps/client/`** — Vite + Preact + TS app, all four screens built. **Wired to the relay**: real
  BIP39 onboarding → key derivation (`src/crypto/`) → device challenge-response auth + LWW
  encrypted-entry push/pull (`src/sync/`, `src/state/data.tsx`). Identity is in-memory while
  unlocked; at rest the seed is either nowhere (re-enter the mnemonic on cold start — the default)
  or, opt-in ("stay signed in on this device"), **sealed under an Argon2id passphrase or a FIDO2
  security key** (§6 at-rest: `crypto/seedlock.ts` Argon2id→XChaCha20 v:1 records — **128 MiB / t=2 /
  p=1** since issue #45, raised from 64 MiB / t=3; params are stored per record so old seals keep
  opening, and 256 MiB was rejected as a mobile-tab OOM risk at ~7 s unlock — with version byte
  + purpose AAD, or v:2 records wrapped by a WebAuthn **PRF-extension** secret from
  `platform/webauthn.ts` — HKDF'd into the wrap key, not offline-brute-forceable; stored in
  IndexedDB via `platform/keystore.ts`; passphrase/security-key unlock on cold start, 15-min
  inactivity auto-lock + manual "Lock journal", phrase rotation re-seals the new seed under either
  method without a new ceremony, a mnemonic sign-in without a seal choice clears the seal, and
  Preferences → Vault → "Device unlock" (`ui/DeviceUnlock.tsx`, `setDeviceUnlock` in
  `state/data.tsx`) switches passphrase ⇄ security key ⇄ off while unlocked. The key is strictly a
  device-unlock convenience — the mnemonic remains the only account/recovery anchor. Regression
  check: `pnpm --filter client exec tsx scripts/seedlock-methods.ts`). Entries are **durable**: a
  per-owner wa-sqlite DB on OPFS (`src/db/`, forward-only client migrations, currently v9 —
  entries, media, templates, media tombstones, journals (+sync bookkeeping), interview types, and a
  one-shot re-push of every record so its ciphertext carries the id binding below; plaintext by §5a design) is the local source of
  truth, seeded once with sample content and merged with synced entries; dirty-flag outboxes let
  edits, deletes, and media uploads survive offline restarts. The editor is real **TipTap**
  (`src/editor/`: toolbar, `/` slash palette, inline media nodes). Entry bodies are
  XChaCha20-Poly1305 encrypted client-side before push, **bound to the record they belong to**
  (second-audit finding M2): every record body — entries, templates, journals, interview types, AI
  settings — takes `mneme:record:v1:<entry_id>` as AAD, so the relay cannot serve one record's
  ciphertext under another record's id (it could otherwise overwrite entry B with entry A's content,
  or resurrect a tombstone, undetectably). `entry_id`/`lww_clock` are still cleartext and
  unauthenticated, so rollback/withhold stays accepted (docs/SECURITY.md §6.7). Pre-binding blobs open
  via a fallback and are retired by the v9 migration's one-shot re-push; a record that will not
  decrypt is skipped with a warning rather than wedging the whole pull. Regression check:
  `pnpm --filter client exec tsx scripts/record-binding.ts`.
- **`server/`** — the Go relay (`journald`): `/healthz` + `/readyz`, embedded forward-only migrations,
  device challenge-response auth (Ed25519), the LWW oplog `sync/push`+`sync/pull`, and CORS. Owner-scoped,
  opaque blobs only. **Registration is owner-authorized** (§6 pairing; audit finding H1, issue #40):
  `/v1/register` carries a second Ed25519 signature by an owner identity signing key the client derives
  from the seed (`HKDF info="identity-sign"`, `crypto/keys.ts` → `ownerSignPub`), over
  `"mneme:bind-device:v1:" ‖ ownerPub ‖ ownerSignPub ‖ devicePub`. The relay pins that key on vault
  creation (migration 0004 `owners.owner_sign_pubkey`) and refuses every later registration not signed
  by it — TOFU now covers *creating* a vault, not *joining* one, so the non-secret `owner_pubkey` no
  longer lets anyone attach a device and overwrite/tombstone/wipe the vault. Pre-0004 owners are
  grandfathered once, only from an already-bound device. Check + writes share one transaction with the
  owner row locked; rejections are a single undifferentiated 401. Regression:
  `server/e2e/binding_e2e_test.go`. **Optional operator approval** (`REQUIRE_APPROVAL`, opt-in, default off — the
  relay stays open TOFU): with it on, a newly registered owner is `pending` (migration 0003 adds
  `owners.status` pending|approved|rejected, existing owners grandfathered to approved) and `/v1/auth/verify`
  won't mint a session (403) — the auth middleware also reads live status every request so
  `POST /admin/owners/{id}/reject` cuts an owner off immediately. Approve/reject live on the admin
  surface (dashboard Status column + buttons). The register call carries an optional `approval_hint`
  the client derives from the seed (`[a-z0-9-]{0,32}`, e.g. `amber-otter-07`, `crypto/hintwords.ts`) so
  the operator can tell pending vaults apart; the client shows a blocking "pending approval" screen
  (`ui/PendingApproval.tsx`, `pending.*` i18n in all 12 locales) quoting it, with a Check-again retry
  (`PendingApprovalError` → `pendingApproval` in `state/data.tsx`). This is the intended way to run a
  single-tenant/family relay — the mnemonic-is-the-account model has no signup to gate otherwise (e2e
  `TestApprovalFlow`; docs/API.md "Admin", docs/SECURITY.md §6.8). **Abuse controls** (audit finding M3, issue #44): a per-client-IP token bucket
  (`internal/api/ratelimit.go`, `RATE_LIMIT_AUTH_PER_MINUTE`/`RATE_LIMIT_AUTH_BURST`, 0 disables) on the
  three unauthenticated endpoints — health probes stay unthrottled. The same bucket bounds guesses at
  `ADMIN_TOKEN` (`RATE_LIMIT_ADMIN_*`, default 10/10, second-audit finding M3), charged on **failed**
  admin authentications only so the dashboard's polling never spends from it. `TRUST_PROXY_HEADERS` opts into
  reading `X-Forwarded-For`, and the **right-most** entry is used because proxies append rather than
  replace (the left-most is caller-controlled) — assumes one trusted hop. Plus a per-owner storage quota
  (`internal/api/quota.go`, `QUOTA_BYTES_PER_OWNER`, **unlimited by default**) enforced on `sync/push`
  and media chunk PUTs; tombstones are exempt so an over-quota vault can delete its way back down. It's
  a pre-flight check, not a transactional reservation — a concurrent burst can overshoot by ~one batch,
  deliberately. Reminders CRUD + scheduler (logs, no push transport yet). Media is **implemented
  server-relayed** (§12 resolved): `internal/blobs` streams client-encrypted ~1 MiB chunks to S3/MinIO
  (minio-go, bucket auto-provisioned) under `/v1/media/*`; `503` when `S3_ENDPOINT` is unset. Chunk
  **cleanup is prefix-driven, not index-driven** (audit finding M2, issue #43): `blobs.Store.DeletePrefix`
  sweeps `media/{owner}/{id}/` on media delete and `media/{owner}/` on vault wipe, because a chunk PUT
  that is never `complete`d has no `media_blobs` row and index-driven cleanup could never reach it —
  it outlived both media deletion and account deletion. Object storage, not the index, is the authority
  on what exists; `store.ListOwnerMedia` was removed so the old pattern can't come back. Push
  delivery is still a stub. **Operator admin surface** (`/admin`, only when `ADMIN_TOKEN` is set,
  otherwise 404): embedded HTML dashboard + `GET /admin/stats` — per-vault storage footprints
  (truncated pseudonymous owner ids) and owner-less daily counters (`usage_daily`, migration 0002,
  deliberately no owner column; request/record/media/vault metrics buffered in-memory, flushed every
  30 s). It cannot count journals or tell media kinds apart — that data never reaches the relay
  (docs/API.md "Admin", docs/SECURITY.md §2). **Vault deletion** exists on both sides, each behind a
  typed-"delete" confirmation: the operator via `DELETE /admin/vaults/{id}` (confirm string enforced
  server-side; dashboard row button + modal) and the user via the client's "Delete vault" sheet
  (`ui/DeleteVault.tsx`, Preferences → Vault → `deleteVault` in `state/data.tsx`: relay
  `DELETE /v1/account` first, then local OPFS destroy + seal clear, back to onboarding). A user
  session can only ever delete its own vault — `/v1/account` takes no id. **Operator backup + disaster
  recovery** is in (`internal/backup`, `internal/store/backup.go`): a backup is one gzipped-tar archive
  of every vault's opaque ciphertext — the bookkeeping tables as NDJSON + the client-encrypted media
  chunks, no keys, no plaintext (`sessions`/`auth_challenges` deliberately excluded). Restore is a
  single transactional truncate-and-replay (`store.Restore`, realigns `entry_seq`) plus chunk
  re-upload. Configured by `BACKUP_DIR`/`BACKUP_INTERVAL`/`BACKUP_KEEP`; a `Service` owns the directory
  (mutexed run-now, scheduled worker, `.partial`→rename atomic writes, retention prune, strict
  name-regex path guard). Two trigger paths: the admin surface (`/admin/backups` list/status, POST
  to back up now → 202 detached, download, typed-`{"confirm":"restore"}` restore, delete; dashboard
  section + restore modal) and CLI subcommands (`journald backup [--out]` / `restore <archive> [--yes]`
  / `list-backups`) — the CLI is the recommended DR path (runs against a stopped/fresh server). Tests:
  `internal/backup/backup_test.go` (fakes, no DB) + `e2e/backup_e2e_test.go` (real Postgres round-trip).
  docs/API.md "Backups & disaster recovery", docs/SECURITY.md §6.14.
  **One-click updates** (`/admin` → "Version & updates"): the dashboard can apply a release and roll
  one back. The relay **cannot update itself** — it is PID 1 in the container being replaced, and
  giving it the Docker socket would put root-equivalent host access behind an HTTP endpoint inside the
  stack it is meant to be the least-privileged part of. So it writes a request into a spool directory
  (`internal/deploy`, `UPDATE_SPOOL_DIR`, off by default) and a **root-owned host agent**
  (`deploy/updater/`: systemd path unit → `mneme-updater.sh`, installed by `install.sh`) does the
  work: backup → pin `deploy/version.env` → pull → `up -d --no-build` → health gate → **automatic
  rollback** if the new version never reports healthy. The health gate is the container `HEALTHCHECK`
  running `journald healthcheck` → `/readyz` (a subcommand because distroless has no curl), which only
  passes once migrations applied *and* Postgres is reachable — so a release that cannot migrate is
  caught rather than left serving errors. The relay's request vocabulary is deliberately two verbs
  (`update <tag>` / `rollback`) with the tag validated **on both sides** against a strict pattern —
  release semver or an immutable per-commit main build (`main-<sha>`, published by CI for every
  green commit on main; the dashboard offers the current head as a "Switch to main" development
  channel, never the bare moving tag `main`); a compromised relay can request a downgrade to a
  published release or a past main build and nothing else (docs/SECURITY.md §6.17). Rollback honesty comes from a **schema contract**: every migration must
  declare `-- rollback: safe|breaking` (parsed by `migrations/manifest.go`, shared with
  `store.Migrate` so an undeclared migration fails at startup, enforced by a test), the release
  workflow publishes it as the release's `mneme-release.json` asset via `journald schema-info`, and
  the relay reads it to say **before** an update whether undoing it is an image swap (`fast`) or needs
  the pre-update archive replayed into a rebuilt database (`deep`, destructive — its own tick-box).
  Prod compose is now **image-based** (`ghcr.io/mneme-blog/mneme-{server,web}`, `build:` kept
  alongside so `--build` still works) and the release workflow publishes the **web** image too, since
  pulling only the relay would leave a split-version deployment. Caveat that is easy to miss: a
  server-side rollback does not undo **client-side** migrations — device OPFS DBs are forward-only too.
- **Infra** — `docker-compose.yml` (Postgres + MinIO + server, `backups` volume), `server/Dockerfile`, `.devcontainer/`.
- **Relay-side security headers** (second-audit finding M1) — `internal/api/headers.go` sets nosniff /
  `X-Frame-Options: DENY` / `Referrer-Policy: no-referrer` / `default-src 'none'` on **every** relay
  response, because the Caddy header block below only covers the SPA route: `/v1/*` and `/admin` had
  none of it, and `/admin` is a document holding `ADMIN_TOKEN` that can wipe every vault. The
  dashboard overrides the CSP with its own — `script-src` pinned to the **sha256 of its inline
  script**, computed at startup from the bytes actually served, so editing the page updates the hash
  by itself (`TestDashboardCSPCoversInlineScript` pins the one assumption: exactly one inline script,
  no `src=`).
- **Content-Security-Policy** (§6's named XSS mitigation; audit finding H2, issue #41) — defined ONCE in
  `apps/client/csp.js` (plain JS) and shipped twice: `vite.config.ts` injects it as a `<meta http-equiv>`
  into the **production build only** (dev needs inline scripts for HMR), and `deploy/web/Caddyfile` sends
  the same string as a response header — authoritative, and the only place `frame-ancestors` is honoured.
  Browsers **intersect** multiple policies, so a drifted pair silently over-restricts: regenerate with
  `pnpm --filter client csp` when changing either. `script-src 'self' 'wasm-unsafe-eval'` (the wasm token
  is required by wa-sqlite; it permits WebAssembly compilation, not `eval`); `style-src` keeps
  `'unsafe-inline'` (inline style attributes + KaTeX). Egress is enumerated: `connect-src` = self +
  `api.anthropic.com` + `nominatim.openstreetmap.org` + loopback Ollama, tiles are `img-src` only. The
  build-time `VITE_RELAY_URL` origin is added automatically; anything else (split-host relay, non-loopback
  Ollama) needs `CSP_CONNECT_EXTRA`. Caddy also sends nosniff / `X-Frame-Options: DENY` / `Referrer-Policy:
  no-referrer` / `Permissions-Policy` (camera+mic+geolocation `self`, rest denied) and strips `Server`.
  `font-src 'self'` has a build-side counterpart: `build.assetsInlineLimit` in `vite.config.ts` keeps
  **fonts out of the inlining path**, because Vite's default inlines every asset under 4 kB as a
  `data:` URI and the policy blocks a `data:` font outright — the small faces (some Hanken Grotesk
  unicode ranges, most KaTeX ones) silently fell back to system fonts in production until this.

Media (§10 step 5) is in for **video, audio, images, and file attachments**: video/audio record via
`getUserMedia`+MediaRecorder in the editor (`ui/VideoCapture.tsx`, `ui/AudioCapture.tsx`, inserted via the `/` slash menu; `addMedia`
in `state/data.tsx`), chunked XChaCha20 encryption under the media key with per-chunk AAD
(`crypto/media.ts`), local plaintext bytes + upload outbox in the wa-sqlite `media` table (schema v2),
background upload + lazy cross-device download (`sync/media.ts`, `state/data.tsx`). A cross-device
download reports **transfer progress** all the way to the card: `RelayClient.downloadMediaChunk`
reads the response as a stream (a ~1 MiB chunk is seconds of silence on a phone) and
`downloadMedia`'s optional `onProgress` accumulates it against the relay's ciphertext total, which
`mediaBlob` forwards to `useMediaUrl` → `MediaLoadingBar` (`ui/Attachments.tsx`, reused by the
gallery tiles, lightbox, interview clips, and location photo). The bar is determinate once the
metadata GET has landed and an indeterminate stripe before that — the local-DB path resolves in one
step and reports nothing, so a card served from disk never flashes a bar. Recordings are
**inline TipTap nodes** (`editor/media.tsx`, a block atom whose attrs carry the `MediaAttachment`
metadata inside bodyJson — still inside the encrypted entry body, `sync/engine.ts`); deleting one
requires an explicit confirmation and then purges the local bytes **and the relay copy**
(`removeMedia` → `DELETE /v1/media/{id}`, idempotent; queued in the local `media_tombstones`
table while offline and retried until acknowledged). Images and files picked or dropped into the
editor embed the same way — images group into galleries and maximize into a keyboard-navigable
lightbox (`ui/Lightbox.tsx`) — and surface in previews and search text. Entries from before inline
media render their attachments-array via the legacy `<AttachmentList>` fallback.

**Entry templates** (§10 step 7, private only) are in: predefined seeds + user-created, all
user-editable/deletable. Templates sync as encrypted blobs **through the entry oplog** — the record
kind (`kind: 'template'`) lives inside the ciphertext (`sync/engine.ts`), so the relay cannot tell
templates from entries and **no server changes were needed**. Built-ins (`data/templates.ts`) seed
once per device as pristine, local-only rows (random ids — a well-known id would leak the record
type); the first edit/delete makes one a real synced record, and its `builtin` slug lets other
devices retire their own pristine seed of it (supersede pass in `state/data.tsx` pull). Built-in
seed **content is localized**: each doc is built from `templates.builtin.*` catalog keys, and a
still-pristine seed re-renders in the active language via `localizeBuiltinTemplate` (a display
projection in the `state/data.tsx` context value, keyed on the locale) — the first edit forks it into
a real synced record in whatever language it was showing, and user/forked templates are content that
stays as written. Local store:
`templates` table (schema v3); rotation carries templates (`sync/rotate.ts`). UI: manager sheet
(`ui/Templates.tsx`, sidebar "Templates" / mobile settings) with create/edit/rename/delete/use, the
`/` slash palette has a single **Template** command that opens the same picker and inserts the
chosen template at the cursor, and the new-journal "Start from" picker is wired
to live templates. Wire-path check: `scripts/templates-roundtrip.ts` (relay must be running). The
§5b signed **public** template registry is still not built.

Recovery-phrase **rotation** is in (the "my mnemonic may have leaked" path): `sync/rotate.ts`
re-encrypts the whole vault (entries + media) under a fresh phrase/owner, then `DELETE /v1/account`
wipes the old owner server-side (cascade in Postgres + best-effort S3 chunk cleanup) and the old
per-owner OPFS DB is destroyed locally. UI: "Replace recovery phrase" sheet (`ui/RotatePhrase.tsx`)
from Preferences → Vault. Old account stays intact until the final
wipe; see docs/SECURITY.md §4 and docs/API.md "Account".

Smaller client features in: **vault-wide search** (`ui/Search.tsx` — ⌘/Ctrl+K palette, desktop
sidebar field, mobile nav, journals-screen bar; filters the decrypted in-memory entries by title,
body, labels, and date spellings — FTS5 is still blocked), label autocomplete in the entry header
(`ui/LabelField.tsx`), editable entry date/time (rides inside the encrypted body — re-dating leaks
nothing to the relay), **entry deletion** behind a confirmation (`ui/ConfirmDialog.tsx`; tombstones
through the LWW oplog, purges referenced media locally and on the relay; tombstoned entries stay in
the raw provider list so LWW keeps winning, consumers see a filtered list), **journal deletion**
behind a typed-"delete" sheet (`ui/DeleteJournal.tsx`, desktop journal-card trash / mobile drill-in
header; `deleteJournal` in `state/data.tsx` tombstones every entry in the notebook through the LWW
oplog and purges their media local + relay. Journals themselves persist in the local `journals`
table — schema v5+v8, seeded once per device pristine, carried across phrase rotation — and **sync
across the vault's devices** as encrypted `kind: 'journal'` records through the entry oplog (no
server changes; `sync/engine.ts`). Leak-guard twist vs. templates: the wire record id is a fresh
random `recordId` and the journal's real id rides INSIDE the ciphertext — the sample notebooks have
well-known ids (`j-tutorial`/`j-personal`) and user notebooks timestamp-encoded ones (`'j-'+Date.now()`),
either of which would leak in the cleartext oplog (§3). Cross-device identity pairs by that inner id
(seeds share fixed ids everywhere), so no builtin-slug machinery: a pulled record beats a pristine
seed outright, otherwise LWW by `updatedAt`; concurrent first-syncs converge by adopting the smallest
record id. Journal deletion tombstones through the oplog like entries, and a deleted journal keeps
its tombstone row so stale copies can't resurrect it), a visible
password-manager autofill target on phrase restore, and **math typesetting** (`editor/math.tsx` —
`@tiptap/extension-mathematics` + KaTeX; type `$$x$$` inline / `$$$x$$$` block, or the `/` Math
commands; click a formula to edit it in a live-preview LaTeX dialog. The formula is a `latex` attr
inside bodyJson, so it stays inside the encrypted entry body; `docToText` surfaces the LaTeX source
to previews/search and `DocPreview` renders it in template previews), and a **preferences overlay**
(`ui/Preferences.tsx` — THE settings surface: desktop sidebar identity row / mobile Settings tab;
the old footer icon strip and mobile settings sheet are gone) with light/dark/system
appearance, six theme skins (Paper/Modern/Terminal/Forest/Blossom/Lavender — full `[data-skin]`
surface/type ramps in `tokens.css`, each light+dark) × six orthogonal accent tints (picking a skin
adopts its default accent; `hooks/useTheme.ts`; all device-local localStorage, never synced — the
old boolean dark key migrates), writing stats computed locally over the decrypted entries
(`state/stats.ts`: totals, streaks, days journaled), the assistant rows (AI settings; Templates and
Ask-my-journal on mobile, where the sidebar isn't there to host them), and the vault section
(identity card with connection status, lock, phrase rotation, vault deletion — rows hand off to the
existing sheets).

Two more shipped features (previously undocumented here): a **WYSIWYG⇄Markdown source toggle** in
the editor (`editor/markdown.ts` — `docToMarkdown`/`markdownToDoc`, a lossless round-trip that
fences custom atoms (media, math, wikilinks, video interviews) so toggling can't destroy them;
regression checks `scripts/markdown-roundtrip.ts` + `scripts/markdown-editor-smoke.ts`), and
**gamification badges** (`state/badges.ts` engine + `hooks/useBadges.ts` + frosted celebration
overlay `ui/BadgeCelebration.tsx`, PR #78 — computed locally over the decrypted entries, like the
writing stats; nothing syncs; regression check `scripts/badges-repro.ts`; the math-formula dialog's
click handling is covered by `scripts/math-click-repro.ts`).

**Lab/learning-notebook capabilities** (a positioning widening, not a pivot): **tables**
(`@tiptap/extension-table` TableKit, resizable; `/` Table command; row/column controls lead the
toolbar strip while the cursor is inside a table — the template editor (`ui/Templates.tsx`) carries
the same toolbar plus a block-and-math-only `/` palette), **code-block syntax highlighting**
(`@tiptap/extension-code-block-lowlight`, lowlight `common` grammars with auto-detect; warm-paper
token theme + dark variant in `editor.css`), and **cross-entry links with backlinks**
(`editor/wikilink.ts`: an inline `entryLink` atom node carrying `{entryId, label}` inside bodyJson —
entry ids are random, so nothing new leaks to the relay; typing `[[` (or the `/` "Link to entry"
command, which just inserts `[[`) opens an entry picker reusing the SlashMenu machinery; node views
re-resolve live titles so renames heal on next open, and deleted targets render as muted dead chips;
a "Linked from" section under the entry lists referencing entries via `docEntryLinks`). All three
node types are registered unconditionally in `buildExtensions` (docs containing them must open
everywhere) and `DocPreview` renders them. Built-in template seeds gained "Experiment log" (results
table) and "Study notes" — fresh vaults only, since builtin seeding is all-or-nothing. Regression
check: `pnpm --filter client exec tsx scripts/labbook-repro.ts` (jsdom, no relay needed).
Deliberately NOT built: compliance-grade ELN features — signed immutable records fight LWW + E2EE.

**Location / travel maps** (§10 feature-completion): an entry can embed a **single pinned place or a
from→to journey** with a **frozen map** and an optional **travel photo**. A new block-atom node
`locationMap` (`editor/location.tsx`) holds `{from, to, zoom, map, photo}` inside bodyJson exactly
like the media nodes — coordinates/labels stay in the encrypted body; the relay only ever sees random
media ids. The map is rendered **once** at insert time: `location/staticmap.ts` composites
OpenStreetMap raster tiles onto a canvas (`crossOrigin='anonymous'` keeps it un-tainted), draws
pin(s) + a route line, and the result is stored as a normal `kind:'image'` media row — so opening the
entry later (or on another device) decrypts that image and makes **no further third-party requests**.
Endpoints come from address search (`location/geocode.ts` → OSM Nominatim, the one per-insert leak),
browser geolocation, or raw `lat,lng` (the latter two leak nothing). Composer dialog
`ui/LocationPicker.tsx` (`/` "Location" command), with privacy copy mirroring the AI cloud card.
`docMediaIds` counts the snapshot + photo so entry/journal deletion purges them local + relay;
`docToText`/`DocPreview` surface the place names. The node is registered conditionally (needs media
handlers, reused from `state/data.tsx`). Regression check:
`pnpm --filter client exec tsx scripts/location-repro.ts` (jsdom: projection math + node + doc
helpers; the canvas/tile compositor is verified manually). See docs/SECURITY.md §2 "Location
snapshots". Deliberately NOT built: live/pan-zoom maps, road-routed directions (the line is
straight), offline self-hosted tiles.

**Opt-in AI assistant** (client-only; off by default; docs/SECURITY.md §2 "opt-in AI assistant"):
`src/ai/` holds a two-backend provider abstraction — Anthropic (BYO API key, direct browser→API
calls via the dangerous-direct-browser-access CORS header) and Ollama (fully local) — behind one
`AiProvider` interface (`ai/types.ts`; an OpenAI-compatible backend is one new file). **Zero relay
involvement**: requests go browser→provider; journal plaintext must NEVER be proxied through the
relay. Two surfaces: **"Ask my journal"** (`ui/AskJournal.tsx`, sidebar row / Preferences on mobile,
only when enabled) — Q&A over the decrypted in-memory entries, context built by `ai/context.ts`
(search-ranked via the extracted `src/search/core.ts` + recency, per-backend char budgets),
streaming, transcript memory-only; and **editor writing help** (`/` slash commands Continue/
Summarize/Suggest-title → `ui/AiActionDialog.tsx`, current entry only, confirm-before-insert;
gated at editor mount). Settings (`ui/AiSettings.tsx`, Preferences → Assistant) carry the
per-backend privacy copy — the cloud card states that context entries leave E2EE for that request.
The API key is sealed at rest: `Identity.aiKey` (HKDF info="ai-settings", `crypto/keys.ts`) wraps
the settings JSON via `crypto/aead.ts` (version byte + AAD `mneme:ai-settings:v1`, `ai/settings.ts`)
into the IndexedDB keystore slot `'ai-settings'`; lifecycle in `state/data.tsx` (load on unlock,
drop on lock, re-seal under the new seed on phrase rotation, cleared on vault deletion; a different
vault's record fails the AEAD tag → unconfigured). The settings also **sync across the vault's
devices** as an encrypted `kind: 'aiSettings'` singleton through the entry oplog (no relay
involvement in AI requests changes — only the encrypted config blob syncs): random wire record id
per device with smallest-id adoption, LWW by `updatedAt`, sync bookkeeping (`AiSyncMeta`) stored
cleartext next to the sealed blob in the keystore record, records from before sync get stamped +
pushed once on unlock, and clearing the settings tombstones the record so the clearing propagates.
Wire-path checks: `pnpm --filter client exec tsx scripts/ai-roundtrip.ts` (Ollama chat step skips
when not running) and `scripts/journal-sync-roundtrip.ts` (journal + aiSettings record routing,
relay must be running).

**Guided interview + AI entry writing** (extends the opt-in assistant; off unless AI is enabled) is
in: the AI now *writes* entries, not just reads them. **"Daily interview"** (`ui/GuidedInterview.tsx`,
desktop sidebar row / mobile Preferences, gated on `aiSettings.enabled` like Ask-my-journal) runs a
short Q&A — the model asks one question at a time, then **synthesizes a draft entry the user reviews
before saving** (no agentic tool-calling; the text-streaming `AiProvider.chat` is unchanged). A
**Freeform draft** option in the same sheet turns a one-line brief into an entry through the same
review→save path. Saved entries are tagged with the interview type's **name as a label**, and
starting an interview feeds the model the recent same-label entries (`ai/interview.ts`
`buildInterviewHistory`) so repeated runs stay continuous ("history-aware"). Synthesis emits simple
Markdown that a new **`editor/doc.ts markdownToDoc`** (headings/lists/quotes/paragraphs, plain-text
runs) turns into a real entry doc; the prompts ask for a leading `# ` title line, which
`splitMarkdownTitle` lifts into the entry's **title** on save (replacing the date-time default; a
draft without one keeps the default — regression check `scripts/interview-title.ts`); prompts live
in `ai/prompts.ts`. **Interview types** are built-in
**and** user-created, and sync exactly like templates — a new encrypted record kind (`kind:
'interviewType'` inside the ciphertext, `sync/engine.ts`) so **no server changes**: same once-per-
device pristine/builtin seeding (`data/interviews.ts`), supersede-on-sync, dirty-flag outbox, local
`interview_types` table (schema **v6**), and phrase-rotation carry alongside templates. Manager sheet
`ui/InterviewTypes.tsx` (Preferences → Assistant, or "Manage interview types" inside the picker).
Wire-path check: `pnpm --filter client exec tsx scripts/interview-types-roundtrip.ts` (relay running).

**Guided VIDEO interview** (the same interview types, answered on camera) is in — reached from the
written interview's picker (a camera button per type) and the mobile compose chooser.
`ui/VideoInterview.tsx` runs `pick → planning → plan → record → saving`. The shaping constraint: the
model **cannot hear a recorded answer**, and browser `SpeechRecognition` ships audio to Google/Apple
servers, which is a non-starter here — so adaptivity moves *before* the session. The whole question
list is planned in **one** call (`ai/prompts.ts videoInterviewPlanPrompt`, line-prefixed `Q: ` output
rather than JSON because the `AiProvider` abstraction has no tool-calling or JSON mode), parsed
forgivingly by `ai/plan.ts` (`parseQuestionPlan`/`toPlan`), and shown in an editable plan step. A bad
or unreachable model **falls back to a built-in question set rather than dead-ending** — unlike the
written interview, the session works with no provider at all. Recording then makes **zero AI calls
and no network requests**: one camera stream is held across every take (this is why it doesn't reuse
`VideoCapture`, which owns its stream for a single take) with a fresh `MediaRecorder` per question,
plus retake / skip / back. Cross-session continuity is unchanged — it has always come from the label
(`buildInterviewHistory`), never a transcript. Saving follows `import/run.ts`: `createEntry`
(synchronous) → `addMedia` per clip → `updateEntry` with a doc holding one **`videoInterview`**
block-atom node (`editor/videointerview.tsx`; pure half in `editor/videointerviewData.ts`, which
`editor/doc.ts` imports — the node module reaches `ui/Attachments` → `state/data.tsx` → `doc.ts`, so
importing it from `doc.ts` would be a cycle). Node attrs pair each question with its clip
(`cards: [{q, clip}]`, `clip: null` = skipped — parallel arrays would desynchronise on a retake),
plus `sessionId`, `typeName`, `film`, `renderedAt`. Everything but the media ids stays inside the
encrypted body. **`docMediaIds` is security-critical here**: one node references up to 7 media rows
(6 clips + the film), more than any other node type, and the repro script asserts that list
*exactly* so a nested reference added later can't silently outlive the entry on the relay.
**Per-question time limit is device-local `localStorage`, deliberately NOT a field on
`InterviewType`** — `sync/engine.ts` encodes that record field by field, so a new field is silently
stripped the moment an older build edits and re-pushes it (LWW field loss, no conflict, no warning).
Because that limit stops the recorder on its own, the on-camera clock **counts down**, with a bar
draining along the bottom of the preview (the digits alone read the same whether they count up or
down) and a red last-10-seconds state. `fmtCountdown` rounds **up** where `fmtDuration` rounds to
nearest: a nearest-rounded countdown parks on `0:00` for the last half second while the camera is
still rolling, which reads as a frozen timer.
**Capture quality** is device-local for the same reason: `mneme.video.quality` = low 640×360 /
**medium 1280×720 (default)** / high 1920×1080, each with a `videoBitsPerSecond` cap — the cap is the
real file-size lever, since browsers default to ~2.5 Mbps whatever the frame size. Constraints are
**`ideal`, never `exact`** (an `exact` miss is `OverconstrainedError` — no camera at all). Left
unconstrained, engines hand back ~640×480, and since the film render adopts the FIRST clip's
dimensions and derives its bitrate from them, capture size sets the keepsake's size too. Both knobs
live in **`ui/recorder.ts`** (`VIDEO_QUALITY`/`cameraConstraints`/`recorderOptions`/
`answerLimitSeconds`/`ANSWER_LIMITS`), shared with `ui/VideoCapture.tsx` (the one-off camera modal
honours the quality too) and with the **Preferences → Assistant → "Video recording"** picker
(`VideoSection` in `ui/Preferences.tsx`; the quality tiles show frame size + ≈MB/min, the limit chips
are `fmtDuration` digits so they need no translation).

**One-click film rendering** stitches the answers into a single video with each question cut in as a
~2.5 s title card. Entirely on-device, no relay involvement, **no CSP and no COOP/COEP change** —
`worker-src 'self' blob:` already covers it, and the wa-sqlite VFS choice stays safe. `video/film.ts`
is the only module the UI imports; it picks **mediabunny 1.52 (MPL-2.0, zero deps) + WebCodecs in
`video/filmWorker.ts`**, falling back to a realtime canvas + `MediaRecorder` re-record
(`video/fallback.ts`, lazy-imported) when WebCodecs is missing — feature-detected on **both**
`VideoEncoder` *and* `AudioEncoder`, since iOS 16.4–18.7 shipped WebCodecs video-only. Output targets
MP4/H.264/AAC, falling back to WebM/VP*/Opus **wholesale** (MP4-with-Opus is legal but unplayable in
QuickTime and older Safari). The load-bearing idea is the **integer clock**: source timestamps are
never passed through — two whole-number counters (`frame`, `audioFrames`) are the only clock, each
clip is resampled onto it, and its audio padded/trimmed to exactly the frame count its video occupies
so picture and sound re-converge at every seam. Title cards are silent but carry **real silence, not
a gap** (a muxer hole around a card is the classic cause of audio drifting late by question four),
and are rasterized on the **main thread** (`video/cards.ts`, reading live theme tokens) because
worker font loading for the bundled faces is unreliable. Renders live in a module-level registry
keyed by session id, so navigating away doesn't cancel one; the result lands via
`state/data.tsx attachFilm` (functional updater — the editor may be long gone), and `stopAllRenders`
runs on vault lock and vault deletion. Source clips are **kept** so the film can be re-rendered or an
answer retaken; "Delete the source clips" on the card is the lever against the doubled footprint.
Caveat: mediabunny lands in its own chunk (~540 kB) but **is PWA-precached**, so an install carries
it whether or not the user ever renders. Checks: `pnpm --filter client exec tsx
scripts/video-interview-repro.ts` (jsdom — plan parsing against real model failure modes, node/doc
helpers, the exact `docMediaIds` list, `setFilmAttr`, timeline and audio maths) and **`node
scripts/film-e2e.mjs`**, which builds `filmtest/` and drives headless Chrome to encode two
deliberately mismatched clips (MKV/VP8/PCM 44.1 kHz mono 640×480@24 + WebM/VP8/Opus 48 kHz stereo
1280×720@30) and assert 0 ms A/V drift — jsdom has no WebCodecs, so this is the only automated cover
for the riskiest part.

**Recording transcription** (extends the opt-in assistant; retroactive, works on any video/audio in
the vault) is in: `ai/transcribe.ts` posts the decrypted recording browser → a speech-to-text server
speaking the OpenAI `/v1/audio/transcriptions` shape. **The deployment bundles one**: a Speaches
container (`whisper` service in both compose files — all-MIT stack) proxied **same-origin** at
`/whisper` (Caddy `handle_path` inside the
`/mneme` block; vite dev proxy mirrors it), and the client **defaults to it** —
that proxy **cannot carry the relay's device auth** (the browser posts audio to it directly, and
routing it through the relay would put plaintext through the one blind component), so it is gated two
ways (second-audit finding H1 + its follow-up). **Allowlist:** only `POST /v1/audio/transcriptions`
(body cap `TRANSCRIBE_MAX_UPLOAD_MEGABYTES`, default 512), `GET /v1/models`, and `POST
/v1/models/{id}` **pinned to `WHISPER_MODEL`** — an open install endpoint is "pull any Hugging Face
repo onto my server" for any passer-by; keep `WHISPER_MODEL` on the `web` container in step with the
`whisper-model` service. **Authorization:** Caddy `forward_auth` → `GET /v1/transcribe/authorize`
(`internal/api/transcribe.go`), which rewrites the sub-request to a **bodyless GET** — so the relay
sees the session token and the declared size, never audio — and answers 204/401/429. The client
attaches its relay session token **only** for the bundled endpoint, decided by one predicate
(`isBundledTranscriptionUrl`: the stored URL is the path form, which cannot name another host); a
user-configured server, loopback included, never receives it. Per-vault bounds are in-memory and
unit-named (`TRANSCRIBE_QUOTA_REQUESTS_PER_DAY` = recordings, default 50;
`TRANSCRIBE_QUOTA_MEGABYTES_PER_DAY`; `TRANSCRIBE_RATE_REQUESTS_PER_MINUTE`/`_BURST_REQUESTS`), the
relay logs the effective policy at startup, and Caddy strips `Authorization` before the whisper hop.
Counters are deliberately not persisted — that would make the relay record how often a vault
transcribes (docs/SECURITY.md §6.18) —
`defaultTranscriptionSettings()` stores the relative path `/whisper` (resolved against the app
origin at use; `bundledWhisperUrl()` respects a path-form `VITE_RELAY_URL`), an absent
`AiSettings.transcription` field falls back to that default, and clearing the URL stores `''` = off.
Same-origin means no CSP/CORS config; a user-configured loopback server is covered by the CSP's
loopback-any-port entries (`http://localhost:* http://127.0.0.1:*`), anything else needs
`CSP_CONNECT_EXTRA`. **Disclosure is per-use, not settings-only** (the bundled default is
non-loopback from every device but the server itself — phones always): any non-local destination
gets a ConfirmDialog naming the resolved host before audio leaves the device
(`TranscriptStrip`/interview card; `TranscribeDestination` rides in through the node handlers since
node views can't reach app context), while loopback runs without a dialog — warning for the
on-device case would train click-through. The transcript is **content, not a media row**: node attrs
inside the encrypted body — `transcript` on `mediaAttachment` nodes (Transcribe strip on video/audio
cards; legacy attachments too) and per card on `videoInterview` nodes ("Transcribe answers" runs
clip-by-clip; transcripts **survive "Delete the source clips"**). `docToText` surfaces them, so
search, previews, and Ask-my-journal see what was said. Being content, they are **editable by hand**:
`TranscriptStrip`'s `onSave` turns the shown text into a textarea, and each caller writes it back its
own way — node attrs re-read from the doc's *current* node (both node views, so a concurrent
transcription isn't resurrected), or the legacy attachments array. An emptied box stores
`undefined`/`null` rather than `''`, which is what puts a card back into the "Transcribe" /
"Transcribe answers" counts. Both node views' `stopEvent` must keep matching `textarea` — without it
ProseMirror handles the keystrokes and typing moves the document instead of filling the box. The **video interview offers auto-transcribe
at start** (toggle in the plan step, default off, carries the destination copy): after save a
detached loop transcribes clip-by-clip and writes back via `setTranscriptAttr`/`attachTranscript`
(the `setFilmAttr` pattern — the sheet is gone when results land). Whisper's `language` is a
**constraint, not a hint** — told the wrong one it transliterates or translates, returning fluent
nonsense instead of an error — so it is **asked for, never inferred**: a **spoken-language picker**
sits under the auto-transcribe toggle in the plan step (`SPOKEN_LANGUAGES`/`spokenLanguage()` in
`ai/transcribe.ts`, device-local `mneme.transcribe.language`, `''` = auto-detect and distinct from
unset; names rendered by `Intl.DisplayNames` so the list needs no i18n). This replaced deriving it
from the **app UI language**, which is a different fact entirely — an English UI is no evidence the
diary is kept in English, and that assumption is what made non-English answers come back as
gibberish. The choice is stored on the session (`lang` in the `videoInterview` node attrs, inside the
encrypted body) so a later "Transcribe answers" — another day, another device — still constrains
correctly; sessions without it mean auto-detect. **Arbitrary uploads stay on auto-detect**: an
unrelated recording has nothing to justify a constraint.
**Speaches does not fetch models on demand** — a transcription for a model that is not in its cache
is answered **404** (its `routers/stt.py`), which shipped as an unexplained "404" on the Transcribe
button. Two halves fix it and both must stay: a one-shot **`whisper-model`** service in both compose
files installs the default model into the cache volume on `up` (`POST /v1/models/{id}`, idempotent,
runs in the whisper image so it pulls nothing extra, **retried 5×** because a multi-minute download
that fails once would otherwise strand a deployment on "no model" with nothing saying to retry;
`WHISPER_MODEL` overrides — keep it in step with `DEFAULT_TRANSCRIPTION_MODEL`. That default is
**`deepdml/faster-whisper-large-v3-turbo-ct2`** (~1.6 GB), which replaced `faster-whisper-small`
(~0.5 GB) because small's non-English accuracy made transcripts read as guesswork; turbo is the full
large-v3 encoder with a 4-layer decoder, so it is near-large-v3 quality at a fraction of the decode
cost. It needs **`WHISPER__COMPUTE_TYPE=int8`** on the CPU image — CTranslate2's `default` on CPU is
float32, ~3 GB resident and markedly slower. The whisper service also needs
**`HF_HUB_DISABLE_PROGRESS_BARS=1`**,
which is load-bearing rather than cosmetic — without it a download dies mid-flight in
huggingface_hub's threaded tqdm bar, `AttributeError: … 'tqdm' has no attribute '_lock'`
(huggingface_hub#3285), surfacing as a 500 from the install endpoint), and the client makes the state
legible: a **404 maps to the `'model'`
AiError hint** (not `network`) so the card says the server has no model, and AI settings →
Transcription has **Check server** (`checkTranscription`, `GET /v1/models` — never sends a recording,
so no per-use disclosure) with a **Download model** action on the `modelMissing` verdict
(`installTranscriptionModel`, Speaches-specific, offered only after that verdict). A server whose ids
just don't match ours also reads as `modelMissing`, hence the copy says "does not list". Regression
check: `pnpm --filter client exec tsx scripts/transcribe-repro.ts` (mocked fetch — wire shape incl.
language, config gating incl. the same-origin default, check/install endpoints + verdicts, write-back
transform, docToText/coercion contracts incl. the session `lang`, CSP); the stored spoken-language
preference is covered in `scripts/video-interview-repro.ts`, which has a DOM. Deliberately NOT built: in-browser whisper (wasm model
download vs. the CSP/bundle posture) and transcription of the stitched film (per-answer transcripts
are strictly more useful).

**Day One import** (§10 step 7, the first import path) is in: Preferences → Vault → "Import from
Day One" (`ui/ImportDayOne.tsx`) takes a Day One **JSON export .zip** and rebuilds it locally as
encrypted entries. `src/import/` does the work — `dayone.ts` unzips (fflate) and resolves each
entry's media moments to bytes, `markdown.ts` is a scoped Markdown→ProseMirror converter (headings,
marks, lists/tasks, quotes, fenced code, `dayone-moment://` media refs → placeholder nodes),
`run.ts` orchestrates: Day One journals become Mneme notebooks (matched by name, else created),
each entry is created then media is encrypted+attached via the normal `addMedia` path (consecutive
images group into a gallery) and the original `creationDate`/tags are written back. **No special
relay path** — imported records encrypt and sync exactly like hand-authored ones; the zip never
leaves the device. Checks: `pnpm --filter client exec tsx scripts/dayone-import.ts` (parse + doc
conversion, mocked surface) and `scripts/dayone-import-persist.ts` (a 101-entry bulk import driven
through real wa-sqlite under the worker's serialized dispatch — guards the `src/db/worker.ts`
request queue: an unserialized worker interleaves the import's fire-and-forget `putLocal` runs with
`flush`'s `markSynced` BEGIN/COMMIT batches on the single connection and corrupts/loses rows).

**Internationalization** (client UI only) is in: **12 languages** — English (source), German, French,
Spanish, Italian, Dutch, Finnish, Mandarin Chinese, Japanese, Korean, Hindi, and **Arabic (full RTL)**.
`src/i18n/`: the English catalog (`en.ts`, composed of per-area fragments under `messages/`) is the
**source of truth** — its keys type every `t()` call (`MessageKey`), so a missing/renamed key is a
compile error. `t(key, {params})` does `{placeholder}` interpolation; `tp(base, count)` picks CLDR
plural variants (`#one`/`#other`) via `Intl.PluralRules`; `fmtDate`/`monthName`/`weekdayName`/
`fmtNumber` replaced every hardcoded English month array with `Intl`, following the app language (not
the OS). Non-English catalogs live in `locales/<code>.ts` (`Partial<Record<MessageKey,string>>`,
default-export) and **lazy-load** — `import.meta.glob('./locales/*.ts')` code-splits each into its own
chunk (only English is in the main bundle). The call must stay **unconditional** — it's a Vite
compile-time macro, so a `typeof import.meta.glob` guard reads as `undefined` at runtime and silently
disables all translation; the tsx repro scripts are handled by a try/catch (English-only fallback)
instead. `main.tsx` wraps the app in `<I18nProvider>` and a `Root` subscriber so a live language switch
re-renders the whole tree (bare `t()` reads stay fresh); `initI18n()` restores the persisted language +
RTL direction before first paint. Language is **device-local** (`localStorage 'mneme.locale'`, like the
theme) — never synced, never content. The switch is Preferences → Appearance (endonyms). RTL: Arabic
sets `<html dir="rtl">`; layout uses **logical CSS properties** (inline-start/end) throughout and
direction-bearing icons opt into mirroring via `<Icon dirFlip>` + the `[dir='rtl'] .dir-flip` rule in
`tokens.css`. The AI assistant is told to reply in the app language (`ai/prompts.ts`,
`currentLocale().english`). Coverage/regression check: `pnpm --filter client exec tsx scripts/i18n-dump.ts`
(writes the flat English reference + prints per-locale full coverage — all locales complete; the
exact key count grows with features, so read it from the script's output rather than here). Known refinement: gendered
languages get neutral phrasing around the shared `{noun}` media-delete placeholder; Arabic plurals use
one/other with an `#other` fallback for two/few/many.

**Installable PWA** is in: `vite-plugin-pwa` (Workbox `generateSW`) precaches the app shell — JS/CSS/
HTML, the wa-sqlite wasm, the bundled fonts, and the icons — and injects a `registerType:'autoUpdate'`
service worker (`apps/client/vite.config.ts`), so paired with the existing
`public/manifest.webmanifest` the app satisfies Chrome/Android installability and runs offline. The SW
is disabled in ordinary `pnpm dev` (keeps day-to-day dev free of asset caching) and turns on only in
the HTTPS "test the install" mode. `navigateFallback` is **relative** (`index.html`, the plugin's own
default) and must stay that way: precache keys resolve against the service worker's URL, so the
sub-path production image (`--base=/mneme/`) caches the shell as `/mneme/index.html` and a
leading-slash fallback would name a URL that was never precached — every navigation throwing
`non-precached-url` instead of being served offline. Because a service worker + install need a **secure context**
(HTTPS or `localhost` — a `http://LAN-IP` dev URL is never installable on a phone), dev HTTPS is
opt-in: `pnpm --filter client dev:https` (self-signed via `@vitejs/plugin-basic-ssl`, good for
localhost) or `DEV_TLS_CERT`/`DEV_TLS_KEY` pointing at a locally-trusted `mkcert` cert (the only thing
a phone's Chrome registers a SW under). Full phone recipe: **docs/PWA.md**. Production hosts serve real
HTTPS, so install works there with no extra config. An **iOS-only, dismissible caveat notice**
(`ui/IOSNotice.tsx`, gated `isIOS() && !isTauri()` in `platform/shell.ts`, `shell.iosNotice.*` i18n
keys in all 12 locales) tells iPhone/iPad users that iOS clears offline storage after ~7 days idle
(framed as the privacy safeguard it is) and their entries restore from the relay on next sign-in —
never shown on Android/desktop or in the Tauri shell; force-preview via
`localStorage['mneme.iosNotice.force']='1'`.

**Link-href allowlisting** (audit finding M1, issue #42): `editor/url.ts` (`isSafeHref`/`safeHref`,
protocols http/https/mailto/tel, relative+fragment OK, browser-ignorable code points stripped before
the scheme check) is the single allowlist, applied in **four** places — the Day One import parser
(`import/markdown.ts`, the untrusted vector), the editor's Markdown parser AND serializer
(`editor/markdown.ts`, so a bad href stored by an older build can't round-trip back), and pinned into
StarterKit's Link mark config (`editor/doc.ts`: `protocols`, `isAllowedUri`, `validate`, plus
`rel="noopener noreferrer nofollow"`). Deliberately not relying on the upstream default. Regression
check: `pnpm --filter client exec tsx scripts/link-safety.ts`.

Not yet: FTS5 (blocked on a custom wa-sqlite wasm build), push transport + reminders UI (step 6),
export + non-Day-One import (step 7), Tauri shells (step 8) and their OS-keychain at-rest storage (§6).

### Frontend design source
The product visual design is a **handoff bundle from Claude Design** (claude.ai/design), available at:
`https://api.anthropic.com/v1/design/h/hrDFaHkF8O7MK0ag7u8I5A?open_file=Mneme.html`
(gzip tarball — `WebFetch` it, then `tar xzf`). Primary file: **`Mneme.html`**. It is a React-UMD +
Babel prototype of four screens — **Onboarding** (mnemonic login/restore/unlock), **Journals**
(library + new-journal sheet), **Calendar** (month grid + day list + heatmap), **Editor** (zen writing
surface) — plus a shared design system. The bundle's `frames/` (iOS bezel, browser window, tweaks panel)
and the "Design review" top-bar/stage are **prototype harness only — do not reproduce them**; build a
real responsive shell instead. The design system is implemented in `apps/client/src/`:
- **Warm-paper palette** (cream/ink/sepia + terracotta accent), dark mode via `[data-theme="dark"]`.
- **Type:** Hanken Grotesk (UI) · Newsreader serif (editor/headings) · Spline Sans Mono (mnemonic/metadata).
- Design tokens live in `src/styles/tokens.css` (`:root` CSS variables); port new design values there.
- The prototype models **multiple notebooks inside one mnemonic account** — this is a UI convenience;
  it does **not** override the §3 "isolated tenants" crypto decision. Journals sync across one
  vault's devices as encrypted records (isolated tenants is about sharing between *owners*, which
  remains a non-goal); their metadata — the journal id included — stays inside the ciphertext.

### What this is (one line)
Open-source, local-first, **end-to-end-encrypted** journal. The server is a
**dumb encrypted-blob relay** — it never sees plaintext, keys, or the mnemonic. See §1 (threat model)
and §7 (why the server is trivial).

### The five things that constrain almost every decision
1. **Server is outside the trust boundary.** No server-side crypto except TLS + opaque blob storage.
   Admin cannot read and cannot recover. (§1, §3 Non-Goals)
2. **The 12-word BIP39 mnemonic *is* the account.** No login, no email, no password. `owner_id` is
   derived from the seed. Forgotten mnemonic = data permanently lost, by design. (§3, §6)
3. **All crypto lives in the frontend** (@noble/@scure — see §3; was libsodium-wasm), once, for every
   client — because the PWA has no Rust shell. Client and server share **only** the wire-format, never
   crypto. (§3, §4)
4. **Every ciphertext is version-prefixed from day one:** `[version:1B][nonce:24B][ct+tag]`,
   XChaCha20-Poly1305 with a random 24-byte nonce. Never AES-GCM. (§3, §6, §11)
5. **Isolated tenants only** — no shared entries, no multi-recipient key wrapping; per-entry
   Last-Write-Wins, no CRDT. (§3)

### Architecture in three layers
- **`apps/client/`** — Vite + Preact + TS. The single web codebase for both the PWA *and* the content
  inside every Tauri shell. Holds crypto (`src/crypto/`), the sync client (`src/sync/`), the local
  wa-sqlite OPFS DB that **is** the source of truth (`src/db/`; FTS5 still pending a custom wasm
  build), the TipTap editor (`src/editor/`), and the dirty-flag offline outbox — all built. (§4, §5a)
- **`apps/desktop/src-tauri/`** — Tauri 2 shell (Rust) for desktop *and* mobile. Rust only here:
  shell + native plugins (notifications, OS keychain, biometrics). Builds **locally only** — not in
  Codespaces (no display; iOS needs macOS/Xcode). (§3, §9)
- **`server/`** — Go relay. HTTP handlers, device challenge-response auth, LWW oplog push/pull, S3
  (MinIO) blob coordination, reminder scheduler + push. Postgres stores only opaque blobs + metadata,
  every handler strictly scoped to `owner_id`. (§4, §5b)

### Commands
```bash
# Infra + Go server
docker compose up -d                 # postgres + minio + server (:8080)
docker compose --profile fullstack up   # also runs the client dev server in compose

# Client dev — pnpm workspace
pnpm install
pnpm --filter client dev --host      # PWA on :5173 (relay on :8080; override VITE_RELAY_URL)
pnpm --filter client dev:https       # HTTPS dev (self-signed) so the PWA is installable — see docs/PWA.md
pnpm --filter client typecheck       # strict tsc
pnpm --filter client build           # typecheck + production build

# Go server (in ./server)
go build -o journald ./cmd/journald
gofmt -l . && go vet ./... && go test ./...
TEST_DATABASE_URL=postgres://journal:journal_dev@localhost:5432/journal_test?sslmode=disable \
  go test -tags e2e ./e2e/...        # full handshake + backup round-trip against a live Postgres

# Operator backup / disaster recovery (same env as the server: DATABASE_URL, S3_*, BACKUP_*)
./journald backup [--out PATH]       # write one archive (BACKUP_DIR or an explicit path)
./journald restore <archive> [--yes] # REPLACE all relay data from an archive (destructive)
./journald list-backups              # list archives in BACKUP_DIR

# Live client↔relay crypto round-trip (relay must be running)
pnpm --filter client exec tsx scripts/integration.ts   # exec runs from apps/client/

# Tauri shells (after §10 step 8) — LOCAL ONLY, never Codespaces (not scaffolded yet)
```
Codespaces (`.devcontainer/`) covers the **server + PWA** end-to-end; Tauri is out of scope there.

### Deeper docs
Plain-English deep-dives live in [`docs/`](docs/): `ARCHITECTURE.md` (diagrams), `SECURITY.md`
(E2EE model + attack vectors), `ENCRYPTION.md` (primitives + key hierarchy), `API.md` (relay
endpoints), `DEPLOYMENT.md` (production stack: Caddy, HTTPS, compose), `MAINTENANCE.md` (backups,
upgrades, health), `FEATURES.md` (what's built today), `ROADMAP.md` (honest status vs. §10),
`PWA.md` (phone install recipe), `CONTRIBUTING.md`. This §0 stays the quick operating guide;
`docs/` expands on it; §1–§12 below remain the binding decisions.

Both security audits live in **`SECURITY-AUDITS.md`** at the repo root, newest first, kept verbatim
as a record (findings are never edited after the fact — what changed is appended in bold): the
second pass (2026-08-05, 12 findings — H1 the unauthenticated whisper proxy, M1 missing relay
security headers, M2 unbound record ciphertexts, M3 unthrottled admin token, plus six Low and two
accepted Info items) and the first (2026-07-13, 18 findings, issues #40–#57). All closed.

### Lint / format (what is actually enforced today)
TS: strict `tsc` (`noUnusedLocals`/`noUnusedParameters`/`noUncheckedSideEffectImports`),
covering `src/` **and** `scripts/`; no ESLint/Prettier config exists yet (§11 names them as the
eventual toolchain — adding them is open work, not current reality). Go: `gofmt` + `go vet`
(both CI-enforced); golangci-lint is likewise §11 aspiration, not configured. Rust: n/a until
the Tauri shells exist. CI also runs the client regression suite (`pnpm --filter client check`)
and shellchecks the deploy scripts.

### Sequencing
Follow §10's build order strictly: scaffold+infra → client plaintext (validate UX) → crypto →
sync → media → reminders/push → feature completion → Tauri shells. **Do not add crypto or sync
before the plaintext client UX is validated.**

### Hard guardrails (will silently break security/privacy if violated)
- Entry IDs are **random, never date/timestamp-encoded** — the relay sees `entry_id` in cleartext, so a
  ULID/timestamp id would leak the writing chronology. Implemented as random 128-bit hex in
  `src/sync/ids.ts`. (This is the leak-guard of §3 winning over the "ULID" wording in §5a/§11.)
- **Never** put the entry date in cleartext IDs; never log/DOM the key; auto-lock on inactivity. (§3, §6)
- Every new ciphertext persistence path **must** include the version byte. (§3, §11)
- Reminders fire generic ("Reminder") — `fire_at` is a *consciously accepted* cleartext leak; the
  client decrypts content locally. Don't try to "fix" accepted leaks in §3. (§3)
- Migrations are versioned and **forward-only**. (§11)

---

# Journal — Decision Document

> Briefing for Claude Code. This document is the **decision source of truth**.
> Architecture decisions under "Locked Decisions" are made — **do not reopen them**,
> only implement. Where something is unresolved, it is marked as `OPEN:`.

---

## 1. What we are building

An **open-source, local-first, end-to-end-encrypted journal**.
Self-hostable (homelab). A family uses it with **separate accounts** — each account is
an **isolated tenant** (its own journal, no shared content).

**Threat model (central, drives everything):** The server operator (admin) is **outside** the
trust boundary. The server **never** sees plaintext, keys, or the mnemonic — only opaque
ciphertext blobs. The admin **cannot read and cannot recover**. This is a deliberate
choice with a sharp consequence: **forgotten mnemonic = data permanently lost**. By design there
is no admin recovery path. The only recovery anchor is the user's 12-word mnemonic.

---

## 2. Requirements

**Must:**
- Smooth on mobile **and** desktop; desktop as its own client.
- PWA (for dev speed + browser access).
- Offline-first.
- E2EE.
- Scales to several hundred users (→ server load is trivial, see §7).
- Rich text + video + audio.
- Labelling, full-text search, calendar, reminders, push notifications.
- Export/import.
- Metadata per entry.
- Public **and** private entry templates.

**Can:** Tables, lists, checklists, inline images.

**Character:** Zen writing mode + quick capture come first. **No** elaborate layout.

---

## 3. Locked Decisions (do not reopen)

| Area | Decision | Reason (short) |
|---|---|---|
| Client codebase | **Vite + Preact + TypeScript**, one web codebase for all shells | Established stack, one editor/UI model for PWA + all Tauri shells |
| Editor | **TipTap (ProseMirror)** | Tables/lists/checklists/inline media native; more mature foundation than Lexical |
| Local DB | **wa-sqlite with `OPFSCoopSyncVFS`** + **FTS5** | Avoids COOP/COEP headers (state of the art 2026 for embedded media); FTS5 carries search |
| Desktop + Mobile | **Tauri 2** (v2.10.x) as a shell around the same web codebase | An iOS PWA does **not** carry offline-first/push/reminders (storage eviction after inactivity, push only when installed). Tauri = persistent container + native notifications + OS keychain |
| PWA | Browser access + dev vehicle — **not** the serious mobile client | see above |
| Backend | **Go** (relay) | I/O-bound, highly concurrent (goroutines), static binary, homelab deploy. No server crypto → Rust's advantages don't pay off |
| Rust | **Only** in the Tauri shells | Mandatory there, nowhere else |
| Crypto location | **Crypto in the frontend**, once, for all clients | The PWA has no Rust shell → crypto can't live primarily in Rust/Go |
| Crypto library | **@noble/@scure** (`@scure/bip39`, `@noble/curves`, `@noble/ciphers`, `@noble/hashes`) — **overrides** the earlier "libsodium-wasm" (user decision 2026-06-09) | Audited, synchronous (no wasm init), tree-shakeable. Primitives from §6 unchanged (BIP39→HKDF-SHA256→XChaCha20-Poly1305, X25519/Ed25519) |
| Server DB | **PostgreSQL** (bookkeeping only: owners, device pubkeys, blob index, reminder times, push subs) | Stores only opaque data + metadata |
| Media store | **S3-compatible, self-hosted** (MinIO/Garage), client-side **chunked** encryption | Chunking enables range requests on ciphertext |
| AEAD | **XChaCha20-Poly1305**, **random 24-byte nonce** | 192-bit nonce → random reuse negligible (reason against AES-GCM) |
| Ciphertext format | **Version-byte prefix from day 1**: `[version:1B][nonce:24B][ct+tag]` | Without it, no clean primitive rotation later |
| Recovery / key backbone | **BIP39 12-word mnemonic** → seed → keys. No login, no email | Operationalizes "admin cannot recover": the mnemonic IS the only recovery anchor |
| Sync model | **Per-entry Last-Write-Wins + offline queue** — **no CRDT** | Single-user/isolated tenants: concurrent edits of the same old entry are rare. Skip CRDT → no tombstone complexity |
| Tenancy | **Isolated tenants only** — no shared content, **no** multi-recipient key wrapping | Sharing would be separate, considerably harder crypto (revocation etc.) |

### Explicit non-goals / guards
- **No server crypto** except TLS + opaque blob storage. The server never decrypts.
- **Do not build a CRDT** (only if concurrent multi-device edit of the same entry actually hurts).
- **No AES-GCM** (nonce discipline); XChaCha20-Poly1305 with a random nonce.
- **No shared entries** / no multi-recipient envelope.
- **Do NOT encode the entry date in cleartext IDs** — otherwise the writing chronology leaks.

### Accepted leaks (deliberate, do not "fix")
The server sees **metadata**: number of entries (≈ frequency), blob sizes, edit frequency,
**reminder times** (cleartext, since the scheduler needs them). E2EE protects **content**, not
**form**. Reminders fire generically ("Reminder") — the client decrypts content locally.

**No freshness guarantee** (also accepted): the AEAD tag stops the relay forging or altering a blob,
but not choosing *which* blob to hand back. A malicious relay can serve a stale ciphertext (rollback —
`lww_clock` is cleartext, so it knows which is older), silently omit a record from a pull, or reorder
and drop. Fixing it needs the client to authenticate the record *set* — a signed manifest / hash chain
/ Merkle root inside the ciphertext — which is unbuilt. The local OPFS DB being the source of truth is
what limits the damage. docs/SECURITY.md §6.7.

---

## 4. Repo structure (monorepo, pnpm + Go module)

```
journal/
├── CLAUDE.md                 # this document
├── README.md
├── docker-compose.yml        # infra + server (see §8)
├── .devcontainer/
│   └── devcontainer.json     # Codespaces (see §9)
├── pnpm-workspace.yaml
├── apps/
│   ├── client/               # Vite + Preact + TS — THE web codebase (PWA + Tauri content)
│   │   ├── src/
│   │   │   ├── crypto/       # libsodium-wasm: mnemonic, seed→keys, aead, chunked-media
│   │   │   ├── db/           # wa-sqlite OPFS, schema, migrations, FTS5, queries
│   │   │   ├── sync/         # offline outbox, LWW oplog client, device-auth
│   │   │   ├── editor/       # TipTap config (tables/lists/checklists/inline-media)
│   │   │   ├── ui/           # zen-capture, timeline, calendar, labels, templates
│   │   │   ├── platform/     # shell abstraction: key-storage, notifications
│   │   │   │   ├── pwa.ts     # WebCrypto/passphrase, web-push (VAPID)
│   │   │   │   └── tauri.ts   # OS-keychain (Stronghold), native notifications
│   │   │   └── main.tsx
│   │   ├── public/manifest.webmanifest
│   │   └── vite.config.ts    # + PWA/Workbox plugin
│   └── desktop/              # Tauri 2 shell — desktop AND mobile targets
│       └── src-tauri/        # Rust: shell only, plugins (notification, keychain, biometric)
├── server/                   # Go relay
│   ├── cmd/journald/main.go
│   ├── internal/
│   │   ├── api/              # HTTP handlers
│   │   ├── auth/             # device challenge-response (pubkey-based)
│   │   ├── sync/             # LWW oplog push/pull, blob relay
│   │   ├── blobs/            # S3 coordination (presigned/relayed)
│   │   ├── reminders/        # scheduler + push dispatch (VAPID + APNs/FCM via Tauri)
│   │   └── store/            # Postgres (sqlc or pgx)
│   ├── migrations/           # goose/atlas SQL
│   ├── Dockerfile
│   └── go.mod
└── packages/
    └── proto/                # wire format (protobuf) — language-neutral, client+server share ONLY this
```

**Sharing note:** Client and server share **only** the wire format (`packages/proto`), not
crypto (that lives in the wasm frontend). This is why being polyglot (Go server + Rust shell)
is no flaw here — the valuable shared part is language-neutral.

---

## 5. Data model

### 5a. Client SQLite (the *real*, decrypted DB — local, source of truth)
```sql
-- all in plaintext, because only on the unlocked device
CREATE TABLE entries (
  id          TEXT PRIMARY KEY,      -- ULID, NOT date-encoded
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  title       TEXT,
  body_json   TEXT NOT NULL,         -- TipTap/ProseMirror JSON
  lww_clock   INTEGER NOT NULL,      -- for LWW (hybrid logical clock recommended)
  deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE entries_fts USING fts5(title, body_text, content='');
CREATE TABLE labels (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT);
CREATE TABLE entry_labels (entry_id TEXT, label_id TEXT, PRIMARY KEY(entry_id,label_id));
CREATE TABLE entry_meta (entry_id TEXT, key TEXT, value TEXT, PRIMARY KEY(entry_id,key));
CREATE TABLE media (
  id TEXT PRIMARY KEY, entry_id TEXT, mime TEXT, bytes INTEGER,
  sha256 TEXT, local_blob BLOB, remote_key TEXT, synced INTEGER DEFAULT 0
);
CREATE TABLE reminders (id TEXT PRIMARY KEY, entry_id TEXT, fire_at INTEGER, dispatched INTEGER DEFAULT 0);
CREATE TABLE templates (id TEXT PRIMARY KEY, name TEXT, body_json TEXT, scope TEXT); -- 'private'|'public'
CREATE TABLE oplog_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT, payload BLOB, created_at INTEGER);
CREATE TABLE sync_state (k TEXT PRIMARY KEY, v TEXT);
```

### 5b. Server Postgres (bookkeeping only — **all opaque or pure metadata**)
```sql
-- owner identity = public key derived from the mnemonic seed; NO password, NO email
CREATE TABLE owners (
  owner_id    TEXT PRIMARY KEY,      -- = hash(owner_pubkey), derived from seed
  owner_pubkey BYTEA NOT NULL,       -- X25519, for sealed-box device pairing
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE devices (
  device_id   TEXT PRIMARY KEY,
  owner_id    TEXT REFERENCES owners(owner_id),
  device_pubkey BYTEA NOT NULL,      -- for challenge-response auth
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE entry_blobs (             -- the LWW oplog: opaque ciphertext blobs
  owner_id    TEXT REFERENCES owners(owner_id),
  entry_id    TEXT NOT NULL,
  lww_clock   BIGINT NOT NULL,        -- server compares ONLY this number, never sees content
  ciphertext  BYTEA NOT NULL,         -- [version][nonce][ct+tag]
  deleted     BOOLEAN DEFAULT false,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (owner_id, entry_id)
);
CREATE TABLE media_blobs (
  owner_id TEXT, media_id TEXT, s3_key TEXT, bytes BIGINT, chunks INT,
  PRIMARY KEY (owner_id, media_id)
);
CREATE TABLE reminders (              -- fire_at is CLEARTEXT (accepted leak)
  owner_id TEXT, reminder_id TEXT, fire_at TIMESTAMPTZ, dispatched BOOLEAN DEFAULT false,
  PRIMARY KEY (owner_id, reminder_id)
);
CREATE TABLE push_subs (owner_id TEXT, device_id TEXT, kind TEXT, endpoint TEXT, p256dh TEXT, auth TEXT);
CREATE TABLE public_templates (id TEXT PRIMARY KEY, name TEXT, body_json JSONB, author_pubkey BYTEA, sig BYTEA);
```
**Tenant isolation:** Every handler scopes strictly to the `owner_id` from the authenticated device.
The server enforces the tenant boundary; an owner never sees another's blobs.

---

## 6. Crypto specification

### Key derivation (all client-side; implementation: @noble/@scure, see §3)
> Implemented in `apps/client/src/crypto/` (`mnemonic`, `keys`, `aead`). `owner_id` = base64url(sha256(ownerPub)),
> identical to the relay derivation. The device key is derived from the seed (info="device") → nothing is persisted.
```
mnemonic (BIP39, 128-bit entropy, 12 words)
  → seed (BIP39, PBKDF2)
  → root_key (HKDF-SHA256, salt="journal-v1")
      ├─ data_key       (HKDF info="data")      # XChaCha20-Poly1305 for entries
      ├─ media_key      (HKDF info="media")      # chunked media
      └─ identity_seed  (HKDF info="identity")   # → X25519 owner keypair → owner_id = hash(pubkey)
```
- **Encrypt an entry:** `version_byte || random_nonce(24) || XChaCha20Poly1305(data_key, nonce, body)`.
- **Media:** in ~1 MiB chunks, each chunk its own nonce; enables range requests.
- **owner_id** is derived from the seed → no separate signup, the mnemonic *is* the account.

### Multi-device pairing (the part that was hard from the start — now solved)
- **Primary (simple, like Evolu):** **Type** the mnemonic on the second device. No transport needed,
  the server is not involved. The mnemonic is the portable secret.
- **Optional (convenience):** The second device generates its own keypair, shows the pubkey as a QR;
  the first device `crypto_box_seal`s the seed to that pubkey, transfer via server relay (the server sees only a sealed blob).

### Key storage at-rest — **correction of an earlier statement**
An earlier project note said "WebCrypto non-extractable CryptoKey". With libsodium that is **not
cleanly tenable**: libsodium needs the raw key bytes in wasm memory, and "non-extractable" (a
WebCrypto concept) doesn't apply there. Honest position:
- **In-memory while unlocked is unavoidable** for wasm crypto. Mitigation: strict CSP against XSS,
  auto-lock after inactivity, never put the key in DOM/logs.
- **PWA at-rest:** Either don't persist the seed at all (re-enter mnemonic/passphrase on cold start) **or**
  encrypt the seed with a passphrase-derived key (**Argon2id**, `crypto_pwhash`) in IndexedDB.
- **Tauri at-rest:** Seed in the **OS keychain** (Stronghold plugin), unlock via OS biometrics.

### Argon2id parameters
`crypto_pwhash` with `MODERATE` as the default; on mobile possibly `INTERACTIVE` (cold-start budget).
Random salt per owner, stored alongside.

---

## 7. Why the server is trivial
Several hundred users × E2EE = the server is a **dumb blob relay**: no content indexing
(impossible, it's ciphertext), no rendering, no heavy queries. LWW = one integer comparison per
entry. Load is I/O, not CPU. "Scales to hundreds of users" is effectively free here — a single
Go binary on the homelab carries it easily.

---

## 8. docker-compose.yml

```yaml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: journal
      POSTGRES_PASSWORD: journal_dev
      POSTGRES_DB: journal
    volumes: [pgdata:/var/lib/postgresql/data]
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U journal"]
      interval: 5s
      timeout: 5s
      retries: 10

  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin_dev
    volumes: [miniodata:/data]
    ports: ["9000:9000", "9001:9001"]
    healthcheck:
      test: ["CMD-SHELL", "mc ready local || exit 1"]   # adjust to curl /minio/health/live if needed
      interval: 5s
      timeout: 5s
      retries: 10

  createbuckets:
    image: minio/mc
    depends_on: { minio: { condition: service_started } }
    entrypoint: >
      /bin/sh -c "
      mc alias set local http://minio:9000 minioadmin minioadmin_dev &&
      mc mb -p local/journal-media || true;
      exit 0;"

  server:
    build: { context: ./server }
    environment:
      DATABASE_URL: postgres://journal:journal_dev@postgres:5432/journal?sslmode=disable
      S3_ENDPOINT: http://minio:9000
      S3_ACCESS_KEY: minioadmin
      S3_SECRET_KEY: minioadmin_dev
      S3_BUCKET: journal-media
      LISTEN_ADDR: ":8080"
    depends_on:
      postgres: { condition: service_healthy }
      minio:    { condition: service_started }
    ports: ["8080:8080"]

  # Optional: client dev server in compose (otherwise directly via `pnpm dev`)
  client:
    profiles: ["fullstack"]
    image: node:22
    working_dir: /app
    command: sh -c "corepack enable && pnpm install && pnpm --filter client dev --host"
    volumes: [".:/app"]
    ports: ["5173:5173"]
    depends_on: [server]

volumes:
  pgdata:
  miniodata:
```

**server/Dockerfile** (multi-stage):
```dockerfile
FROM golang:1.23 AS build
WORKDIR /src
COPY server/go.* ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build -o /journald ./cmd/journald

FROM gcr.io/distroless/static-debian12
COPY --from=build /journald /journald
EXPOSE 8080
ENTRYPOINT ["/journald"]
```

Start up: `docker compose up -d` (infra + server). Full, incl. client: `docker compose --profile fullstack up`.

---

## 9. GitHub Codespaces — `.devcontainer/devcontainer.json`

```json
{
  "name": "journal-dev",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu-24.04",
  "features": {
    "ghcr.io/devcontainers/features/node:1":   { "version": "22" },
    "ghcr.io/devcontainers/features/go:1":     { "version": "1.23" },
    "ghcr.io/devcontainers/features/rust:1":   {},
    "ghcr.io/devcontainers/features/docker-in-docker:2": {}
  },
  "forwardPorts": [5173, 8080, 5432, 9000, 9001],
  "postCreateCommand": "corepack enable && pnpm install && (cd server && go mod download) && docker compose up -d postgres minio createbuckets server",
  "customizations": {
    "vscode": {
      "extensions": ["golang.go", "rust-lang.rust-analyzer", "dbaeumer.vscode-eslint", "esbenp.prettier-vscode"]
    }
  }
}
```

In the Codespace then: `pnpm --filter client dev --host` → port 5173 (PWA). The server runs on 8080.

### Important Codespaces caveat
**Codespaces covers server + web client (PWA) end-to-end** — fully developable and testable.
The **Tauri shells** (desktop + mobile) do **NOT** build usefully in Codespaces: no display, and
**iOS strictly requires macOS/Xcode**. Tauri builds happen **locally**. Maturity flag: Tauri 2 mobile
is stable-usable, but "not all desktop plugins are ported to mobile" — before the
mobile push path, check the available notification plugins.

---

## 10. Build order (for Claude Code to sequence)

1. **Scaffold + infra:** Monorepo, compose, devcontainer, Postgres migrations, Go server skeleton + `/healthz`.
2. **Client local, plaintext:** Vite+Preact+TS, wa-sqlite OPFS + schema + FTS5, TipTap, zen capture, timeline. **No crypto yet, no sync** — validate UX first.
3. **Crypto layer:** BIP39 onboarding, seed→keys, XChaCha20 + version byte, at-rest model (§6). Still local-only.
4. **Sync:** LWW oplog outbox (client) + Go relay push/pull, device auth (challenge-response), encrypted-blob transport.
5. **Media:** chunked encryption + MinIO via server-coordinated upload.
6. **Reminders + push:** Server scheduler, web push (VAPID) for PWA + native notifications in Tauri.
7. **Feature completion:** Templates (public signed-cleartext / private encrypted), export/import (encrypted archive + optional plaintext export), calendar/labels/metadata UI.
8. **Tauri shells:** Desktop first, then mobile — built **locally**, not in Codespaces.

---

## 11. Conventions
- **Language:** Code, comments, variables, commits, API → **English**.
- **TS:** strict mode. **Go:** `gofmt`/`golangci-lint`. **Rust:** `clippy`.
- **IDs:** ULID, never date-encoded (leak guard).
- **Migrations:** versioned, forward-only.
- **Secrets:** never commit; compose uses `_dev` defaults for local only.
- On every new ciphertext persistence: **don't forget the version byte.**

## 12. OPEN (genuine open points)
- `OPEN:` Hybrid logical clock vs. simple Lamport counter for `lww_clock`.
- `OPEN:` Media upload: server-relayed vs. presigned S3-PUT (presigned = less server load, but the MinIO endpoint must be reachable).
- `OPEN:` Verify the Tauri mobile push plugin state before step 6.
- `OPEN:` `crypto-pouch`/attachment encryption irrelevant (no PouchDB) — dropped.
