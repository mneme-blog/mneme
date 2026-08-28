# Roadmap

Where Mneme actually is, told without the usual flattering hand-waving. The binding build order is
[`CLAUDE.md`](../CLAUDE.md) §10; this page is the honest status board that tracks against it.

Three columns, three honesties:

- ✅ **Built** — done, wired, and working today (in the browser app).
- 🔜 **Next / planned** — genuinely not done. Not "basically done." Not done.
- 🚫 **Deliberately not building** — considered and rejected on purpose, so nobody files it as a bug.

---

## ✅ Built

### Foundation & crypto
- BIP39 12-word onboarding → key derivation → **XChaCha20-Poly1305** entry encryption, chunked media
  encryption, version-byte envelope from day one.
- At-rest seed sealing (opt-in "stay signed in"): **Argon2id passphrase** seal (v:1) *and*
  **FIDO2 / WebAuthn PRF security-key** seal (v:2), switchable in Preferences → Vault.
- **15-min inactivity auto-lock** + manual lock; seal survives phrase rotation.
- **Recovery-phrase rotation** (full re-encrypt under a new identity, then wipe the old owner).
- **Record-bound ciphertexts** — every record body takes its cleartext wire id as AAD, so the relay
  cannot serve one record's ciphertext under another's id.
- **Strict Content-Security-Policy** (one definition, shipped as a Caddy header *and* a build-time
  `<meta>`) — the design's named XSS mitigation for in-memory keys — plus link-href allowlisting.

### Local-first storage & sync
- Durable per-owner **wa-sqlite database on OPFS** (schema v9) as the source of truth; forward-only
  client migrations; dirty-flag offline outboxes for edits, deletes, and media uploads.
- **Encrypted LWW sync** (push/pull) with device Ed25519 challenge-response auth; offline-tolerant
  30 s sync loop.

### Editor & content
- Real **TipTap** editor: rich text, `/` slash palette, inline media nodes.
- **Tables**, **code blocks with syntax highlighting**, **math (KaTeX)**, **cross-entry links +
  backlinks**.
- **Media**: video/audio recording, images + galleries + lightbox, file attachments,
  **location / travel maps** (frozen static snapshot).
- **Markdown source toggle** in the editor (lossless round-trip; custom atoms are fenced, not lost).
- **Templates** (built-in + user, synced as encrypted oplog records).
- **Multiple journals** that sync across a vault's devices (metadata inside the ciphertext).
- Editable per-entry date/time, labels + autocomplete.

### Finding & organising
- **Vault-wide search** (⌘/Ctrl+K) — substring, over decrypted in-memory entries.
- **Calendar** (month/year/timeline + heatmap), **writing stats** (totals/streaks/days), and
  **gamification badges** — all computed locally over decrypted entries, none of it synced.
- Entry, journal, and whole-vault deletion, each confirmation-gated and propagated.

### Localization & presentation
- **12-language UI** (en, de, es, fr, it, nl, fi, ar, hi, ja, ko, zh) with `Intl` date/number
  formatting, pluralization, and full **RTL** support for Arabic. Device-local, never synced.
- **Six theme skins × six accents**, light/dark/system.
- **Installable PWA** — precached app shell, offline-capable, autoUpdate service worker.

### AI assistant (opt-in, off by default, never through the relay)
- Two backends behind one interface: **Anthropic** (BYO key) and **Ollama** (fully local).
- **Ask my journal**, **editor writing help**, **guided written interviews** + **freeform draft**,
  fifteen built-in and user-editable **interview types** (synced as encrypted records).
- **Guided video interviews** — the question list planned in one call, an editable plan step, then a
  recording session that makes zero AI calls and zero network requests.
- **One-click film rendering** — answers stitched into one video with title cards, entirely
  on-device (WebCodecs via mediabunny, realtime-canvas fallback).
- **Recording transcription** — retroactive, per recording or per interview answer, against the
  speech-to-text server the stack bundles (relay-authorized, per-vault allowances) or your own
  loopback one. Transcripts are content inside the encrypted body: searchable, editable, and they
  outlive the recording.
- AI settings (API key included) sealed at rest and synced as an encrypted record.

### Import
- **Day One import** (JSON export `.zip` → local encrypted entries; media, dates, tags preserved).

### The relay & operations
- Go relay `journald`: `/healthz` + `/readyz`, device auth, LWW oplog push/pull, **server-relayed
  chunked media** to S3/MinIO, reminders CRUD + scheduler (logs only, see below), account deletion,
  configurable CORS.
- **Admin dashboard** + `/admin/stats` (pseudonymous per-vault footprints, owner-less daily counters),
  operator **vault deletion**.
- **Abuse controls**: per-IP token buckets on the unauthenticated and admin-auth endpoints, a
  per-owner storage quota, and relay-side security headers on every response.
- **Owner-authorized device registration** (an owner-identity signature proves seed possession) and
  optional **operator approval** of new vaults (`REQUIRE_APPROVAL`) for a single-tenant/family relay.
- **Bundled speech-to-text** (Speaches, same-origin via Caddy) behind a relay authorization gate that
  sees the session token and declared size — never the audio.
- **Backup + disaster recovery** (`internal/backup`): gzipped ciphertext archives via the admin
  surface *and* the `journald backup` / `restore` / `list-backups` CLI.
- **Production deployment stack**: `docker-compose.prod.yml` + `deploy/prod.sh` + Caddy (HTTPS on one
  origin), self-hosted fonts, runtime-configurable relay URL, the `platform/` shell seam — installed
  by the one-command `deploy/install.sh`.
- **Release automation + one-click updates**: tagged `v*` releases publish server and web images via
  GitHub Actions; the dashboard applies a release (or a per-commit `main` build) and rolls one back
  through a root-owned host agent — with a pre-update backup, a health gate, automatic rollback, and
  a per-migration `safe`/`breaking` schema contract that says up front whether undoing it is an image
  swap or a destructive replay.

---

## 🔜 Next / planned

### Native shells (in progress)
- **Tauri 2 desktop + mobile shells** — the serious mobile client. **Track A** (the web-side
  foundation: `platform/` seam, keystore dispatcher, notify seam, runtime relay URL, self-hosted
  fonts) is **done** on `feat/tauri-shell-foundation`. **Track B** (the actual Rust shell, native
  notifications, keychain/biometric unlock) builds **locally only** — iOS needs macOS + Xcode, so it
  can never be a Codespaces job. Why bother, when the PWA is otherwise complete? iOS: OPFS gets evicted
  after ~7 days idle and web-push for reminders is unreliable. Android rides the same shell for free.
- **OS-keychain at-rest seal** (a `v:3` seal whose wrap secret lives in OS secure storage, gated by
  biometrics) — the Tauri half of the at-rest story.
- **Reminders that actually fire**: local **scheduled OS notifications** from the synced `fire_at`
  times, plus the reminders UI. This deliberately *replaces* server push (see below).

### Client
- **FTS5 full-text search** — blocked on a custom wa-sqlite wasm build; the migration is sketched in
  `src/db/schema.ts` and waiting.
- **Export** (encrypted archive + optional plaintext) and **non-Day-One import**.

### Security hardening backlog
(Tracked in full, with severities, in [SECURITY.md](./SECURITY.md); the two internal audit passes and
what each finding turned into are in [`SECURITY-AUDITS.md`](../SECURITY-AUDITS.md) — all findings
closed.)
- **Authenticate the rest of the framing** — record bodies now bind their wire id as AAD, so the relay
  can't serve one record's ciphertext under another's, but `deleted` / `lww_clock` are still cleartext
  and unauthenticated: rollback, withhold, and reorder remain accepted (a signed manifest or hash
  chain is unbuilt).
- **HLC or Lamport `lww_clock`** to stop leaking real wall-clock edit times.
- **OS-keychain at-rest seal** — the Tauri half of the at-rest story (see above).
- **External security audit** before any 1.0 or real-data use. The two audits so far were internal.

### Server / protocol
- **`packages/proto`** shared wire-format (JSON for now).
- **Public signed template registry** (§5b) — private templates already ride the oplog as ciphertext
  and need no server support.

---

## 🚫 Deliberately not building

These are decisions, not omissions. Please don't "fix" them.

- **CRDTs.** Isolated single-user tenants + per-entry Last-Write-Wins is enough; CRDT tombstone
  complexity buys nothing here (CLAUDE.md §3).
- **Shared / multi-recipient entries.** Sharing is a separate, much harder crypto problem (revocation,
  key wrapping). Out of scope by design.
- **AES-GCM.** XChaCha20-Poly1305 with a 192-bit random nonce, specifically to avoid nonce-management
  footguns (CLAUDE.md §3).
- **Server-side crypto / admin recovery.** The whole point is that the operator *can't* read or
  recover your journal. A "forgot password" link is not a feature we're missing; it's a threat we
  designed out.
- **Compliance-grade ELN features** (signed immutable records) — they fight directly with LWW + E2EE.
- **Live pan/zoom maps, road-routed directions, offline self-hosted tiles.** Location snapshots are
  frozen images on purpose; the route line is deliberately straight.
- **Server push (APNs/FCM/VAPID) + `push_subs` + a dispatcher.** Each device schedules its own local
  notifications from the synced `fire_at` times. This fits E2EE, works offline, and deletes an entire
  server subsystem. The relay keeps its `LogDispatcher` stub and we are entirely at peace with that.
