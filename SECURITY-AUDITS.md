# Mneme — Security audits

Every security audit of this repository, newest first, kept **verbatim** as a record. Findings are
never edited after the fact: what changed in response is appended to each item in bold, and the
assessment that produced it stays as it was written. That is the point of keeping them — a module
rated "C+" that is an "A−" a week later is evidence the process works, not an embarrassment to tidy
away.

| Audit | Date | Findings | Status |
|---|---|---|---|
| [Second pass — Claude (Opus 5)](#second-pass--2026-08-05) | 2026-08-05 | 12 (1 High, 3 Medium, 6 Low, 2 Info) | all resolved 2026-08-05 |
| [First pass — Claude (Fable)](#first-pass--2026-07-13) | 2026-07-13 | 18 (2 High, 4 Medium, 7 Low, 5 Info) | all resolved 2026-07-31 |

Neither is an external audit. Both are code-level reviews against the threat model in CLAUDE.md
§1/§3 and `docs/SECURITY.md`; the project has **not** had a third-party assessment — see
`docs/SECURITY.md` §7.

---

# Second pass — 2026-08-05

**Auditor:** Claude (Opus 5)
**Date:** 2026-08-05
**Scope:** Full repository, with emphasis on everything built since the first audit
(the first pass below, 2026-07-13, all 18 findings closed 2026-07-31): the guided video
interview and film renderer, recording transcription and the **bundled whisper service**, the
**one-click update mechanism** (relay spool + root host agent), operator backup/restore, the
admin dashboard, journal/AI-settings record sync, and the production deploy
(`docker-compose.prod.yml`, `deploy/`).
**Method:** Manual read of every security-critical file on both sides of the trust boundary —
the Go relay (`server/`), the deploy layer (`deploy/`, compose files, CI workflows), and the
client's crypto/sync/AI/editor paths (`apps/client/src/`) — against the threat model in
CLAUDE.md §1/§3 and `docs/SECURITY.md`.

---

## Status: all 12 findings resolved (2026-08-05)

Every item below is checked off. The assessment and each finding are kept verbatim for the record —
what changed is appended to each item in bold. Summary of the work:

| | Finding | Resolution |
|---|---|---|
| H1 | Unauthenticated, unrestricted whisper proxy | Caddy forwards an allowlist (transcribe + model list + install pinned to `WHISPER_MODEL`), 512 MB body cap, everything else 404 |
| M1 | No security headers on relay responses | `internal/api/headers.go` — nosniff / DENY / no-referrer / `default-src 'none'` everywhere, plus a hash-pinned CSP for the dashboard |
| M2 | Record ciphertext not bound to its id | `mneme:record:v1:<entry_id>` as AAD on every record kind + a one-shot re-push (client DB v9) |
| M3 | Admin token guesses unthrottled | Failed `/admin` authentications go through a per-IP bucket (`RATE_LIMIT_ADMIN_*`) |
| L1 | Root updater runs from a writable checkout | Installer and agent both name the paths root does not own, and the fix |
| L2 | Release-asset URL followed unchecked | https + a GitHub-owned host required |
| L3 | Unbounded `entry_id` / `reminder_id` | 1–128 chars of `[A-Za-z0-9_.:-]` |
| L4 | Restore read archive members unbounded | Per-member size limits + media member names must be a chunk path |
| L5 | Stored relay URL trusted on read | Re-normalized where it is used |
| L6 | Dashboard interpolated data into `innerHTML` | `esc()` at every sink; the server-side constraints stay as defence in depth |
| I1 | `/admin` page served unauthenticated | Accepted — by design; it holds no data and prompts for the token |
| I2 | `0.0.0.0` classified as loopback | Accepted — it does resolve to the local host, and it affects a label only |

Regression coverage added: `apps/client/scripts/record-binding.ts` (M2 — relabelling rejected, legacy
blobs still open, a poisoned record does not wedge the pull), `TestDashboardCSPCoversInlineScript` and
`TestSecurityHeaders` (M1), `TestAdminTokenGuessesAreThrottled` (M3), `TestReleaseAssetHost` (L2).

Not re-verified here: the Go `e2e` suite and the relay-dependent client scripts, which need Postgres
and a running relay (no Docker daemon in the environment the fixes were made in). Everything else
runs clean — `gofmt`, `go vet` (e2e build tag included) and `go test ./...`, `pnpm --filter client
typecheck` and `build`, and the eight relay-free repro scripts.

Two of the module ratings below are worth re-reading with the fixes in mind: the admin surface's
**C+** was earned by the missing headers, the missing throttle and the raw interpolation — all three
are now closed — and the deploy layer's **C** was the whisper route.

---

## Overall security rating

**B+ — the first audit's remediation holds up, and the core E2EE promise is intact. One
High-severity gap, and it is not in the relay at all: it is the unauthenticated service that
now sits next to it.** (≈ 8 / 10)

Re-verified as still correct: `owner_pubkey` is no longer treated as a secret (H1's owner-key
binding is enforced in one locked transaction), the CSP exists and is generated from a single
source, every store query is parameterized and `owner_id`-scoped, media cleanup sweeps object
storage rather than the index, and the one-click updater is genuinely well-designed — the relay
can ask for exactly two verbs against a doubly-validated tag and cannot name an image, a
registry, a path, or a command.

What this pass found is concentrated in **what the deployment now exposes** rather than in what
the relay does. The relay is carefully throttled, owner-scoped, quota'd and confirmation-gated;
the whisper container proxied beside it under the same origin has none of that, and neither the
relay's own responses nor its admin dashboard carry any of the security headers the SPA route
gets. The one genuinely cryptographic finding (M2) is a missing binding that turns the already
accepted "the relay can serve you a stale blob" into "the relay can serve you a *different*
blob" — cheap to close, and worth closing before the docs claim more than the code does.

### Module / component ratings

| Area | Rating | One-line justification |
|---|---|---|
| Crypto primitives (`crypto/aead`, `keys`, `media`, `seedlock`) | **A−** | Correct XChaCha20-Poly1305, version byte, random nonce, HKDF domain separation, per-chunk AAD, Argon2id at 128 MiB with per-record params. |
| Record encryption / sync integrity (`sync/engine.ts`) | **B−** | Confidentiality is sound; record *identity* is unauthenticated — no AAD binds a blob to its `entry_id` (M2). |
| Server auth + tenant isolation (`api/auth.go`, `store/`) | **A** | Owner-key-authorized binding, uniform failure responses, live approval status, parameterized owner-scoped SQL, no IDOR. |
| Media / blob handling (`api/media.go`, `blobs/`) | **A−** | Owner-scoped, path-safe keys, prefix-driven cleanup. Minus: `entry_id`/`reminder_id` accepted unvalidated (L3). |
| Admin surface (`api/admin.go`, `dashboard.html`) | **C+** | Constant-time token, 404 when unset, typed confirmations — but no throttle (M3), no security headers, framable, and raw interpolation into `innerHTML` (M1, L6). |
| Backup / restore (`internal/backup`) | **A−** | Airtight name regex, atomic writes, no keys or plaintext in archives. Minus: unbounded member reads on restore (L4). |
| One-click updates (`internal/deploy`, `deploy/updater/`) | **A−** | Two verbs, tag validated on both sides, backup-first, health-gated, auto-rollback. Minus: root agent runs scripts out of an operator-writable checkout (L1). |
| Update check (`api/version.go`) | **B** | Bounded reads, cached, disable-able. Minus: follows an arbitrary asset URL named by the feed (L2). |
| Deploy / exposure (`Caddyfile`, `docker-compose.prod.yml`) | **C** | TLS, CSP, nosniff and Permissions-Policy on the SPA — and an unauthenticated, unrestricted proxy to the whisper container next to it (H1). |
| Client content rendering / XSS (`editor/`, `import/`) | **A−** | Link allowlist in all four places, explicit KaTeX hardening, text-node rendering, no `eval`. |
| AI assistant / privacy (`ai/`) | **A−** | Browser→provider only, key sealed at rest, fenced prompts, per-use disclosure for non-local transcription. |

---

## Findings — TODO list

Ordered by severity. Each item: what it is, where, why it matters, and the fix.

### 🔴 High

- [x] **H1 — The bundled speech-to-text server is proxied to every client of the deployment
  with no authentication and no restriction on which of its endpoints are reachable.** — **Fixed:** the `/whisper` route now forwards only `POST /v1/audio/transcriptions` (512 MB body cap), `GET /v1/models`, and `POST /v1/models/{id}` restricted to the deployment's `WHISPER_MODEL`; every other path is a 404. What remains — open transcription compute for anyone on the network — is written down as an accepted LAN trade in docs/SECURITY.md §6.18, with the two ways out (put auth in front of it, or drop the whisper services).
  `deploy/web/Caddyfile:63-69` (`handle_path /whisper/*` → `reverse_proxy whisper:8000`),
  `docker-compose.prod.yml:123-181` (the `whisper` / `whisper-model` services).
  **Problem:** the relay's own API is behind device auth, per-IP throttling, a per-owner quota
  and typed confirmations. The whisper container sitting beside it on the same origin has none
  of that: `/mneme/whisper/*` forwards **anything** to Speaches, unauthenticated, with no path
  or method allowlist and no request-body cap. Anyone who can reach the site can therefore
  - **spend the server's CPU at will** — a transcription pins a core for minutes, and the route
    is the cheapest denial-of-service in the deployment (no token bucket applies to it);
  - **make the host download arbitrary Hugging Face repositories** via
    `POST /v1/models/{id}` — the install endpoint the client's "Download model" button uses
    takes any repo path, so it is unbounded disk consumption and unbounded egress, and it loads
    third-party artifacts into a long-lived server process;
  - reach every **other** route the image exposes — model deletion, the text-to-speech
    endpoints, and the service's own UI — none of which the client ever calls.
  The response timeout is deliberately raised to 600 s on this route, so each abusive request is
  also long-lived. Nothing here can decrypt a journal (E2EE is untouched), but the promise that
  the deployment is safe to expose rests on the relay being the only reachable API, and it is
  not.
  **Fix:** allowlist the three endpoints the client actually uses
  (`POST /v1/audio/transcriptions`, `GET /v1/models`, and the install `POST /v1/models/{id}`
  restricted to the model the deployment configures), 404 everything else, and cap the request
  body. Document that the whisper route is unauthenticated by design, so an operator exposing
  the site beyond a trusted network knows to put auth in front of it.

### 🟠 Medium

- [x] **M1 — The relay sends no security headers at all, so the admin dashboard is framable and
  runs with no CSP while holding the admin token.** — **Fixed:** `internal/api/headers.go` sets nosniff, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `default-src 'none'` on every relay response, so the baseline holds whatever fronts it. The dashboard overrides the CSP with its own: `script-src` pinned to the sha256 of its single inline script (computed from the bytes actually served, so it cannot drift), `connect-src 'self'`, `frame-ancestors 'none'`.
  `deploy/web/Caddyfile:45-56` (the `/v1/*`, `/healthz`, `/readyz`, `/admin*` handlers carry no
  `header` block — it lives only inside the SPA `handle` at `:91-107`),
  `server/internal/api/admin.go:42-50`, `server/internal/api/server.go:110`.
  **Problem:** `apps/client/csp.js` and the Caddy header block protect the *client app*. The
  relay's own responses — including `GET /admin`, a full HTML application that keeps
  `ADMIN_TOKEN` in `sessionStorage` and can approve owners, delete vaults, download every
  vault's ciphertext, restore an archive and restart the stack — are served with no
  `Content-Security-Policy`, no `X-Frame-Options`, no `frame-ancestors`, no
  `X-Content-Type-Options` and no `Referrer-Policy`. Two consequences: the dashboard can be
  framed by any page (clickjacking against Approve/Reject/Back-up-now, which are single-click
  and unconfirmed), and any injection into that page — today's markup is safe, see L6 — would
  execute unconstrained and exfiltrate the admin token to anywhere. The CSP is treated as part
  of the crypto boundary for the client (§6); the surface that can wipe every vault gets none of
  it.
  **Fix:** set the headers in the relay itself rather than only at the proxy, so they hold for
  any deployment shape: `nosniff` / `X-Frame-Options: DENY` / `Referrer-Policy: no-referrer` on
  every response, plus a strict per-page CSP for the dashboard (`frame-ancestors 'none'`, a
  hash for its single inline script, no external origins).

- [x] **M2 — A record's ciphertext is not bound to the record it belongs to: the relay can move
  one record's encrypted body onto another record's id and the client accepts it.** — **Fixed:** every record body is encrypted with `mneme:record:v1:<entry_id>` as AAD, so a relabelled blob fails its tag. Blobs written before the binding open via a fallback and are retired by a one-shot re-push (client DB migration v9); a record that will not decrypt is now skipped with a warning instead of wedging the vault's sync from that cursor onwards.
  `apps/client/src/sync/engine.ts:185,255,284,315,340` (every `encrypt(dataKey, …)` call passes
  no AAD) and `:380` (decrypt likewise); `apps/client/src/crypto/aead.ts:13-28` (AAD is
  supported — media chunks use it; entries, templates, interview types, journals and AI settings
  do not).
  **Problem:** `entry_id` and `lww_clock` travel in cleartext and are not covered by the AEAD
  tag. The tag proves a blob was written by someone holding the data key, but says nothing about
  *which record it was written for*. A malicious or compromised relay can therefore take the
  (perfectly valid) ciphertext of entry A, serve it under entry B's id with a higher clock, and
  the client will decrypt it successfully and overwrite B with A's content — silently, with no
  integrity error, on every device. The same trick duplicates one entry across arbitrarily many
  ids, and resurrects a tombstoned record by re-serving its old body under a new id. docs/
  SECURITY.md §6.7 accepts that the relay can *withhold or roll back* a blob; substituting the
  content of one record with another's is a strictly stronger primitive, it is not what §6.7
  says is accepted, and unlike freshness it costs almost nothing to close.
  **Fix:** pass an AAD that pins each record to its wire id (`mneme:record:v1:<entry_id>`) on
  encrypt, and require it on decrypt, falling back to the unbound form only for blobs written
  before the change — plus a one-time re-push so those legacy blobs stop being the weak case.

- [x] **M3 — Nothing throttles guesses at `ADMIN_TOKEN`.** — **Fixed:** failed admin authentications go through a per-IP token bucket (`RATE_LIMIT_ADMIN_PER_MINUTE` / `_BURST`, default 10/10). Successes are never charged, so the dashboard's polling is unaffected and an attacker cannot lock the operator out.
  `server/internal/api/admin.go:25-38` (`adminAuth`), `server/internal/api/server.go:96-108`
  (every `/admin/*` route), versus `server.go:76-78` where the three unauthenticated *client*
  endpoints are rate-limited.
  **Problem:** the comparison is constant-time, which stops a timing attack, but there is no
  limit on how many attempts a caller may make. The admin surface is by far the most powerful
  one on the relay — vault deletion, backup download (every vault's ciphertext), restore, and
  a stack restart onto a chosen release — and it is protected by a single static bearer token
  that an operator picks by hand. The endpoints that can only create an owner are throttled;
  the one that can destroy every owner is not.
  **Fix:** run failed admin authentications through the same per-IP token bucket, with a much
  tighter budget than the client endpoints.

### 🟡 Low

- [x] **L1 — The root updater agent executes and sources files out of a checkout the operator's
  own (non-root) account can write.** — **Fixed (disclosed, not blocked):** the installer lists exactly which executed paths root does not exclusively own and gives the one-line fix, and the agent repeats the warning in the log the dashboard shows, on every run. Deliberately not fatal — it is the documented layout, and failing mid-update would help nobody. Named as a residual risk in docs/SECURITY.md §6.17.
  `deploy/updater/mneme-updater.sh:49,129` (`COMPOSE="$REPO_DIR/deploy/prod.sh"`, run as root),
  `deploy/prod.sh:21-30` (`source deploy/version.env` with `set -a`),
  `deploy/updater/install.sh:56-62` (installs the agent's own script to root-owned
  `/usr/local/lib/mneme`, but leaves `REPO_DIR` wherever the operator cloned it — `/home/...`
  is the documented normal case).
  **Problem:** the agent hardens everything about its *own* inputs — a fixed registry, a tag
  re-validated against a strict pattern, a config file only root can write — and then runs
  `$REPO_DIR/deploy/prod.sh` as root, which sources `deploy/version.env` from the same tree.
  Anyone who can write that checkout (the operator's normal user account, or any process running
  as it) gets arbitrary root code execution the next time an update runs. It is a real
  escalation even though the same account is usually in the `docker` group already, and it is
  invisible: nothing in the install output says the checkout is now a root-privileged input.
  **Fix:** have the installer verify that `REPO_DIR` and the files the agent executes are
  root-owned and not group/world-writable, refuse (or warn loudly) otherwise, and have the agent
  re-check ownership of the compose wrapper before running it.

- [x] **L2 — The update check follows an arbitrary URL named by the release feed.** — **Fixed:** the asset URL must be https on a GitHub-owned host; anything else is logged and skipped, degrading to the “unknown rollback cost” the check already reports for a release with no manifest.
  `server/internal/api/version.go:202-207` and `:290-312` (`fetchSchemaManifest` requests
  `asset.browser_download_url` verbatim).
  **Problem:** the relay's single deliberate outbound destination is documented as
  `api.github.com`. In practice it also fetches whatever URL the release JSON puts in
  `browser_download_url` for the asset named `mneme-release.json` — with no scheme or host
  check. A tampered or redirected feed (or a `UPDATE_CHECK` pointed at a mirror) turns a
  server-side GET into one aimed at any address the response chooses, including addresses only
  the relay's network can reach. The blast radius is small (the body is parsed for two integers
  and discarded, the fetch is 5 s and 1 MiB bounded), but "the relay talks to exactly one host"
  should be true in the code, not just in the comment.
  **Fix:** require `https` and a GitHub-owned host before following the asset URL.

- [x] **L3 — `entry_id` and `reminder_id` are accepted with no length or charset limit.** — **Fixed:** both ids take 1–128 characters of `[A-Za-z0-9_.:-]` — wider than what any client mints, so no existing outbox can wedge on it.
  `server/internal/api/sync.go:61` (`if e.EntryID == ""`), `server/internal/api/reminders.go:46`.
  **Problem:** `media_id` is properly constrained (`^[A-Za-z0-9_-]{16,64}$`, media.go:29) because
  it becomes an object-storage key. The oplog's own primary key gets only a non-empty check, so
  an authenticated owner can push records keyed by megabyte-long ids (up to the 32 MiB body
  limit, 500 per request), which are stored, indexed, and echoed back on every pull. Where no
  `QUOTA_BYTES_PER_OWNER` is set — the default — that is unbounded growth in a key column, and
  it is storage the quota's own accounting (which measures ciphertext) does not see.
  **Fix:** validate both ids against the same shape the client actually generates.

- [x] **L4 — Restore reads archive members with no size bound.** — **Fixed:** members are bounded before they are read (2 MiB for a media chunk, a large ceiling for the NDJSON tables) and a media member's name must match the exact `media/{owner}/{media}/{n}` shape, so a crafted archive cannot write an object outside the media namespace.
  `server/internal/backup/restore.go:84` (`io.ReadAll(tr)` per media member; the NDJSON decoders
  are likewise unbounded).
  **Problem:** `Restore` is the one place the relay parses a file it did not just write — and it
  is reachable from `POST /admin/backups/{name}/restore` and the `journald restore` CLI, i.e.
  from any archive an operator was persuaded to place in `BACKUP_DIR`. A gzip archive declaring
  a huge member expands into memory until the process dies. The archives are operator-supplied
  rather than attacker-supplied, so this is a robustness/DR-safety issue more than an exposed
  vulnerability, but disaster recovery is exactly when a hostile or truncated archive is
  plausible.
  **Fix:** bound each member (a chunk can never exceed the relay's own `maxChunkBytes`) and the
  archive's total member count/size.

- [x] **L5 — The stored relay URL is trusted verbatim when read back.** — **Fixed:** `getStoredRelayUrl` re-normalizes; anything that is not an absolute http(s) URL reads as unset and falls back to the build-time default.
  `apps/client/src/sync/relay.ts:217-224` (`getStoredRelayUrl` returns the raw localStorage
  string; only the Preferences editor calls `normalizeRelayUrl`).
  **Problem:** validation lives at the write path, so any value that reaches the key another way
  — a hostile same-origin neighbour (§6.15), a stale value from an older build, a synced profile
  — becomes the sync endpoint unchecked. The CSP's `connect-src 'self'` keeps the damage
  theoretical in the standard deployment, and the payload is ciphertext regardless, but a
  setting that decides where the vault is pushed should be validated where it is *used*.
  **Fix:** re-normalize on read and ignore anything that isn't an absolute http(s) URL.

- [x] **L6 — The admin dashboard interpolates server-supplied strings straight into `innerHTML`.** — **Fixed:** `esc()` moved to the top of the script and applied at every sink.
  `server/internal/api/dashboard.html:396-406` (vault rows: `owner_id`, `vault`),
  `:412-414` (`status`, `approval_hint`), `:463-471` (backup names).
  **Problem:** safe **today**, and deliberately so — `status` is a Postgres `CHECK`-constrained
  enum, `approval_hint` is charset-validated in the register handler, `owner_id` is a base64url
  hash, and backup names match an anchored regex. But the page has an `esc()` helper it uses in
  the update panel and not here, so the safety of the vault table rests entirely on four
  separate invariants staying true elsewhere in the codebase. That is exactly the "relying on a
  distant default for an XSS-critical control" pattern the first audit called out (M1/L3 there),
  and it is amplified by M1 above: this page has no CSP.
  **Fix:** escape at the sink; keep the server-side constraints as defence in depth.

### 🔵 Info / accepted

- [x] **I1 — `GET /admin` serves the dashboard HTML without authentication** — **Accepted.** No change beyond the strict CSP it now carries from M1. (`admin.go:42-50`)
  whenever `ADMIN_TOKEN` is set — by design: the page prompts for the token and holds no data.
  It does make "this relay has an admin surface" discoverable. Accepted; noted because the
  header work in M1 touches the same handler.

- [x] **I2 — `ollamaScope` classifies `0.0.0.0` as loopback** — **Accepted.** No change. (`apps/client/src/ai/ollamaUrl.ts:48`).
  Defensible (it resolves to the local host on the platforms in question) and it only affects a
  label, but it is the one address in that list that isn't literally loopback. Accepted.

---

## Where the approach is unconventional (and a more standard one would be safer)

1. **Bundling a second, unauthenticated service inside an E2EE product's origin (H1).** The
   whole architecture is built on "the only thing reachable is a dumb relay that can't read
   anything". Adding a general-purpose ML server on the same origin, with its own management
   API, quietly breaks that sentence. **Best practice:** anything co-hosted with the app is part
   of the attack surface — expose the minimum verbs, or put it behind the same auth as
   everything else.

2. **Security headers as a property of the web route rather than of the server (M1).** The
   policy is generated once and shipped twice, which is good design — but only for the SPA. The
   relay produces HTML too, and it is the HTML that matters most. **Best practice:** send the
   baseline headers from the origin server, so they cannot be lost by a deployment that fronts
   the relay differently.

3. **Authenticating record *contents* but not record *identity* (M2).** Mainstream E2EE sync
   binds the ciphertext to its key/slot (and often to a version) via AAD precisely so the server
   cannot shuffle blobs. Mneme already does this for media chunks — the record layer just never
   picked it up. **Best practice:** every AEAD call gets an AAD naming where the ciphertext
   belongs.

4. **A single static bearer token as the whole admin authentication story (M3).** No throttle,
   no rotation, no second factor, no audit trail beyond `log.Printf`. Fine for a homelab, thin
   for something that can download every vault's ciphertext. **Best practice:** at minimum rate
   limit it; consider binding the dashboard to a local-only listener for internet-exposed hosts.

5. **A root agent whose inputs are hardened everywhere except the filesystem it runs from (L1).**
   The request path is meticulously constrained and the code path is not. **Best practice:** a
   privileged unit executes only root-owned files.

---

## What is done well (verified this pass, no action needed)

- **The first audit's fixes are real and still hold.** Owner-key-authorized device binding is
  enforced inside one transaction with the owner row locked, and every rejection is a single
  undifferentiated 401 (`auth.go:120-139`, `store.go:80-148`). The approval gate fails closed on
  a lookup error and is re-read on every request. Challenge and verify answer identically for
  unknown and wrong-key devices.
- **The one-click updater is the right shape.** The relay writes a request and gains nothing:
  two verbs, a tag validated independently on both sides against release-or-`main-<sha>`, a
  fixed registry, backup before change, a health gate that only passes once migrations applied,
  automatic rollback on failure, and a schema manifest so "can this be undone" is answered
  honestly *before* the operator commits. The privileged half is a separate root unit precisely
  so the Docker socket never enters the container. This is better than most self-update designs.
- **Tenant isolation.** Every authenticated handler reads `owner_id` from the session principal;
  every query is parameterized and owner-scoped; media keys and the deletion sweeps embed the
  authenticated owner, so neither can reach another tenant.
- **Deletion means deletion.** Media cleanup enumerates the object-storage prefix instead of the
  index, so chunks that were never finalized are swept by both media deletion and account
  deletion.
- **Backups contain no secrets**, are written `.partial`-then-renamed into a `0700` directory,
  and every admin-supplied name goes through one anchored regex before touching the filesystem.
- **Client-side content handling.** The link-href allowlist is applied in all four places, KaTeX
  is hardened explicitly rather than by default, search highlighting and AI output render as
  text nodes, imported zips never touch a filesystem, and the map compositor keeps the canvas
  untainted.
- **AI privacy plumbing.** Requests go browser→provider only, the key is sealed under an
  HKDF-derived vault key with purpose AAD, journal excerpts are fenced with a per-request random
  token, and any non-loopback transcription destination is disclosed per use rather than only in
  settings.

---

### Suggested remediation order
1. **H1** (restrict the whisper route) — it is the only finding a stranger can reach today.
2. **M1** (security headers on the relay + dashboard CSP) and **M3** (throttle the admin token) —
   both protect the surface that can destroy every vault.
3. **M2** (bind records to their ids) — closes an integrity primitive the docs do not claim.
4. The Low items as hardening, **L1** first if the host is shared with anyone.

---

# First pass — 2026-07-13

**Auditor:** Claude (Fable)
**Date:** 2026-07-13
**Scope:** Full repository — Go relay (`server/`), Preact/TS client (`apps/client/`), crypto
(`src/crypto/`), sync (`src/sync/`), deploy config (`docker-compose.yml`, `deploy/`), and the
architecture as described in `CLAUDE.md` §1–§12 and `docs/`.
**Method:** Manual read of every security-critical file plus two parallel deep-dive passes (server
trust boundary; client XSS/SSRF/exfiltration surface).

---

## Status: all 18 findings resolved (2026-07-31)

Every item below is checked off and its issue closed. The original assessment and each finding are
kept verbatim for the record — what changed is appended to each item in bold. Summary of the work:

| | Finding | Resolution |
|---|---|---|
| H1 | Unauthorized device→owner binding | Registration requires an owner-identity-key signature; the relay pins it per owner (migration 0004) |
| H2 | No CSP or security headers | One policy in `apps/client/csp.js`, shipped as a Caddy header + `<meta>` fallback; verified in Chrome |
| M1 | Unvalidated link `href` | `editor/url.ts` allowlist in both parsers, on serialize, and in the Link extension config |
| M2 | Orphaned media chunks | Cleanup sweeps the object-storage prefix instead of the media index |
| M3 | No rate limiting / quota | Per-IP token bucket on the auth endpoints + `QUOTA_BYTES_PER_OWNER` |
| M4 | Weak Argon2id cost | 64 MiB/t=3 → 128 MiB/t=2; residual risk and the PRF preference documented |
| L1 | Fail-open approval gate | Lookup errors now 500 instead of falling through |
| L2 | No HTTP timeouts | Read/Write/Idle set |
| L3 | Implicit KaTeX safety | `trust:false`, `maxExpand`, `maxSize`, `strict` passed explicitly |
| L4 | Unvalidated Ollama URL | `ai/ollamaUrl.ts` classifies the address; badge and copy reflect where text actually goes |
| L5 | Permissive CORS default | `CORS_ORIGINS=""` now means an empty allowlist (it silently meant `"*"`); startup warning |
| L6 | Error-detail leakage | Generic client messages, detail to the log |
| L7 | Unbounded push batch | 500-entry cap; the client chunks to match |
| I1 | Same-origin co-hosting | SECURITY.md §6.15 + a warning in the Caddyfile |
| I2 | Rollback / withhold | SECURITY.md §6.7 rewritten around the missing freshness guarantee |
| I3 | Prompt injection | Random-token fencing around all journal content in prompts (`ai/fence.ts`) |
| I4 | Device enumeration | Challenge and verify answer uniformly |
| I5 | AI cloud disclosure | Consolidated into `ui/ProviderBadge.tsx`; fixed a wrong-recipient label |

Two bugs were found while fixing these and are noted in the relevant commits: `CORS_ORIGINS: ""` in
`docker-compose.prod.yml` resolved to `"*"`, and the L4 change briefly made a LAN Ollama report "sent
to Anthropic" until I5 consolidated the badge.

Not re-verified here: the Go `e2e` suite and the relay-dependent client scripts, which need Postgres
and a running relay (unavailable in the environment the fixes were made in). They compile and vet
clean; run them before release.

---

## Overall security rating (as audited, 2026-07-13)

**B — Strong architecture, several hardening gaps. Two High-priority items to close before any
internet-exposed deployment.** (≈ 7 / 10)

The core E2EE promise — *the operator cannot read plaintext, keys, or the mnemonic* — **holds**.
Encryption primitives are correct and modern, the relay is genuinely a dumb owner-scoped blob store,
all SQL is parameterized, there is no cross-tenant IDOR on the data paths, and secrets are never
logged. The weaknesses are concentrated in **(a) the authorization model for binding devices to an
account**, **(b) defense-in-depth that the project's own threat model assumes but did not ship
(CSP)**, and **(c) DoS / resource-exhaustion hardening**. Confidentiality is well protected;
**integrity and availability** are where the gaps live.

### Module / component ratings

| Area | Rating | One-line justification |
|---|---|---|
| Crypto primitives (`crypto/aead`, `keys`, `media`, `mnemonic`) | **A−** | Correct XChaCha20-Poly1305, version byte, random nonce, HKDF domain separation, per-chunk AAD. Minus: Argon2 params reduced below the cited target. |
| At-rest seed protection (`crypto/seedlock`, `platform/webauthn`, `keystore`) | **B+** | Solid Argon2id + WebAuthn-PRF dual path, per-purpose AAD. Minus: weakened KDF cost; same-origin co-hosting caveat. |
| Server sync + store (SQLi / IDOR) | **A** | Every query parameterized and `WHERE owner_id = $1`; owner read from session, never the body. No cross-tenant access. |
| Server auth model (`api/auth.go`) | **C+** | Ed25519 challenge-response is sound, but device→owner binding is unauthenticated TOFU, no rate limiting, one fail-open branch. |
| Media / blob handling (`api/media.go`, `blobs/`) | **B** | Well owner-scoped, path-safe S3 keys. Minus: un-finalized chunks survive account deletion; no per-owner quota. |
| Admin + backup surface (`api/admin.go`, `backup/`) | **A−** | Constant-time token, airtight filename regex, typed confirmations, no plaintext in archives. Minor error-string leak. |
| Client content rendering / XSS (`editor/`, `import/`) | **B−** | Mostly careful (text nodes, `crossOrigin`, escaped search). Minus: no CSP; unvalidated link `href`; implicit KaTeX safety. |
| AI assistant / privacy (`ai/`) | **B+** | Correct BYO-key direct-browser pattern, no relay proxying of plaintext, key sealed at rest. Minus: Ollama `baseUrl` unvalidated vs. its "on-device" label. |
| Transport / CORS / HTTP headers (`cors.go`, `Caddyfile`, `index.html`) | **C+** | No security headers anywhere; default `CORS_ORIGINS="*"`. Safe *today* (bearer, no cookies) but fragile. |

---

## Findings — TODO list

Ordered by severity. Each item: what it is, where, why it matters, and the fix.

> Each finding is tracked as a GitHub issue ([#40](https://github.com/plasticparticle/mneme/issues/40)–[#57](https://github.com/plasticparticle/mneme/issues/57)) in
> `plasticparticle/mneme`, labelled `security` + `severity:*` + `area:*`. The issue link sits at the
> start of each item below.

### 🔴 High

- [x] [#40](https://github.com/plasticparticle/mneme/issues/40) · **H1 — A device can be bound to an existing account without proving ownership of the account
  key (account takeover / remote vault destruction).** — **Fixed:** registration now requires an
  Ed25519 signature by an owner identity key derived from the seed; the relay pins it per owner
  (migration 0004) and TOFU survives only for creating a vault.
  `server/internal/api/auth.go:31-100` (`handleRegister`), `server/internal/store/store.go:56-77`
  (`RegisterOwnerDevice`). *This is the project's own acknowledged `TODO(§6 pairing)` at auth.go:29.*
  **Problem:** Registration only verifies the caller controls the *device* key
  (`ed25519.Verify(devicePub, registerMessage(ownerPub, devicePub), sig)`). It never verifies the
  caller controls the *owner identity key*. `owner_id` is derived from the client-supplied
  `owner_pubkey`, and the device row is inserted unconditionally. So anyone who learns a victim's
  32-byte `owner_pubkey` can generate their own device keypair, self-sign the registration, and bind
  their device to the victim's owner. They then pass challenge→verify, mint a valid session, and can:
  **pull all of the victim's ciphertext blobs**, **push blobs with a high `lww_clock` to overwrite or
  tombstone every entry (LWW)**, delete media, and call **`DELETE /v1/account` to wipe the entire
  vault server-side**. They cannot decrypt (no seed) — so confidentiality holds — but this is full
  **integrity + availability** compromise. `REQUIRE_APPROVAL` does not help (status is owner-level;
  the victim is already approved). The gating factor is `owner_pubkey` secrecy: it is not exposed by
  any read endpoint today, but it lives in operator backups and is *meant* to be transmitted in the
  not-yet-built QR pairing flow — so the whole design currently treats the owner **public** key as if
  it were secret, which contradicts "the pubkey is not sensitive."
  **Fix:** binding a device to an *existing* owner must be authorized — either a signature by the
  **owner identity key** over the new device pubkey, or an existing device session must approve it.
  First-device (new-owner) registration can remain TOFU.

- [x] [#41](https://github.com/plasticparticle/mneme/issues/41) · **H2 — No Content-Security-Policy or security headers anywhere — the threat model's primary XSS
  mitigation is missing.** — **Fixed:** one policy in `apps/client/csp.js`, shipped as a Caddy
  response header and a `<meta>` fallback in the build, plus nosniff / frame-ancestors /
  Referrer-Policy / Permissions-Policy. Verified end-to-end in Chrome (wasm, OPFS worker, KaTeX,
  fonts, editor — no violations).
  `apps/client/index.html` (no CSP `<meta>`), `deploy/web/Caddyfile` (no `header` for CSP /
  X-Frame-Options / X-Content-Type-Options / Referrer-Policy / Permissions-Policy), `vite.config.ts`
  (no headers).
  **Problem:** `CLAUDE.md` §6 explicitly names *"strict CSP against XSS"* as the mitigation that
  makes the unavoidable in-memory key exposure acceptable. It was never shipped. The vault seed and
  every derived key live in JS memory while unlocked, so **any** script injection (see M1, a future
  TipTap/KaTeX regression, or a compromised dependency) can read the seed and all plaintext out of
  memory and exfiltrate them — unrecoverably, since the mnemonic is the sole recovery anchor. There
  is also no `frame-ancestors` (clickjacking) and no `Referrer-Policy`.
  **Fix:** ship a strict CSP as a response header from the hosting layer (Caddy `header`), with a
  `<meta>` fallback. Reconcile `connect-src` with the app's real egress: the relay origin,
  `https://api.anthropic.com`, the user's Ollama origin, `https://nominatim.openstreetmap.org`,
  `https://*.tile.openstreetmap.org`; `img-src 'self' blob: data:` + tile host; `script-src 'self'`
  (no `'unsafe-inline'`). Note inline styles are used heavily, so `style-src` will need
  `'unsafe-inline'` (or a refactor). Add `X-Content-Type-Options: nosniff`,
  `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`.

### 🟠 Medium

- [x] [#42](https://github.com/plasticparticle/mneme/issues/42) · **M1 — Untrusted Markdown produces link marks with an unvalidated `href` (`javascript:` /
  `data:` stored XSS).** — **Fixed:** one allowlist (`editor/url.ts`) applied in both parsers, on
  serialize, and pinned into the Link extension config; regression script `scripts/link-safety.ts`.
  `apps/client/src/import/markdown.ts:54-57` (Day One import — the untrusted vector),
  `apps/client/src/editor/markdown.ts:443` (and `:170` on serialize).
  **Problem:** Both Markdown parsers build a TipTap `link` mark straight from the parsed URL with no
  protocol check: `{ type: 'link', attrs: { href: m[2] } }`, where `m[2]` is `([^)]+)` — any
  characters. StarterKit **does** register the `<a href>`-rendering Link mark (confirmed:
  `@tiptap/starter-kit@3.26.1` bundles `@tiptap/extension-link@3.26.1`), and `editor/doc.ts:27` uses
  the default Link config, so protocol safety depends **entirely** on the library default rather than
  any app-level check. A crafted Day One export `.zip` containing `[click](javascript:steal())`
  reaches this path on import. Chained with H2 (no CSP), a click yields full key/plaintext
  compromise. (DocPreview does not render hrefs, and the AI-insert path is plain text, so those are
  safe.)
  **Fix:** validate the protocol in **both** parsers before creating the mark — allow only
  `http`/`https`/`mailto`/`tel`, drop the mark otherwise — and configure the Link extension
  explicitly with a strict `isAllowedUri`/allowlist rather than relying on defaults. Apply the same
  allowlist on the serialize side (`markdown.ts:170`) so a bad href can't round-trip.

- [x] [#43](https://github.com/plasticparticle/mneme/issues/43) · **M2 — Un-finalized media chunks are never garbage-collected — they survive account deletion,
  breaking the "delete my vault" guarantee.** — **Fixed:** cleanup now enumerates the owner's
  object-storage prefix (`blobs.Store.DeletePrefix`) instead of walking the media index, so
  never-finalized chunks are swept by both media deletion and account deletion.
  `server/internal/api/media.go:71-92` (`handlePutMediaChunk`), `server/internal/api/account.go:30-60`
  (`wipeOwner`), `media.go:158-187` (`handleDeleteMedia`).
  **Problem:** `handlePutMediaChunk` writes a chunk to `media/{owner}/{mediaID}/{n}` with no
  requirement that the object ever be `complete`d and no `media_blobs` index row. All cleanup keys off
  that index — `wipeOwner` and `handleDeleteMedia` only delete chunks listed in `media_blobs`. So any
  chunk uploaded but never finalized is orphaned forever: uncounted in admin stats, not removed by
  media delete, and **not removed even by full account deletion / mnemonic rotation**. An
  authenticated owner can PUT arbitrary `mediaID` (`[A-Za-z0-9_-]{16,64}`) / `n` (up to 9999, 2 MiB
  each) to persist opaque ciphertext that outlives their account — both storage griefing and data
  that survives the deletion promise.
  **Fix:** during `wipeOwner`/`handleDeleteMedia`, enumerate and delete the `media/{owner}/` object
  prefix directly (not just indexed chunks); and/or reject chunk PUTs for a `mediaID` that was not
  pre-registered, plus an expiry sweep for un-finalized uploads.

- [x] [#44](https://github.com/plasticparticle/mneme/issues/44) · **M3 — No rate limiting on the public auth/register endpoints; no per-owner storage quota.**
  — **Fixed:** per-IP token bucket on the three auth endpoints (`RATE_LIMIT_AUTH_*`) plus a
  per-owner storage quota (`QUOTA_BYTES_PER_OWNER`, unlimited by default).
  `server/internal/api/server.go:55-57`, `server/internal/api/auth.go` (all three handlers),
  `server/internal/api/media.go`.
  **Problem:** `/v1/register`, `/v1/auth/challenge`, `/v1/auth/verify` are unauthenticated and
  unthrottled. `handleChallenge` inserts a fresh `auth_challenges` row per call for any known
  `device_id` (table flooding between 15-min purges). With `REQUIRE_APPROVAL` off (the default), an
  anonymous caller can create unlimited owners and push unlimited blobs — **arbitrary storage
  consumption with no authenticated actor and no backstop**. There is no per-owner media/blob quota
  either, so a single authenticated owner can fill disk (the `maxMediaChunks` cap is "a sanity cap,
  not a quota," ~10 GiB *per media object*, unlimited objects).
  **Fix:** per-IP rate limiting on the three auth/register endpoints; a per-owner storage quota; and
  for internet-exposed deployments, default `REQUIRE_APPROVAL=on` or a registration cap.

- [x] [#45](https://github.com/plasticparticle/mneme/issues/45) · **M4 — Argon2id at-rest KDF cost is well below the parameters the design cites.**
  — **Fixed:** raised to 128 MiB / t=2 (double the peak memory, ~2.4 s unlock). 256 MiB stays
  rejected — 7.4 s in pure JS and a real OOM risk in a mobile tab — with the residual risk and the
  preference for the WebAuthn-PRF path documented in ENCRYPTION.md and SECURITY.md §4.
  `apps/client/src/crypto/seedlock.ts:31` — `DEFAULT_KDF = { t: 3, m: 64 MiB, p: 1 }`.
  **Problem:** §6 names libsodium `MODERATE` (256 MiB, ops 3). The code deliberately drops to 64 MiB
  (pure-JS Argon2 at 256 MiB is too slow in a browser). The sealed seed is an offline-brute-forceable
  artifact on disk, so its only protection against a stolen device + weak passphrase is the KDF cost —
  a 4× memory reduction and `p=1` measurably lowers the bar. This is a **conscious, documented**
  tradeoff, but it is a genuine reduction from the stated target and should be visible.
  **Fix:** raise `m` as far as the unlock budget allows (e.g. 128–256 MiB with async yielding, which
  is already in place); the params are stored per-record, so old seals still open. At minimum,
  document the residual risk and encourage the WebAuthn-PRF path (not offline-brute-forceable) as the
  preferred device-unlock method.

### 🟡 Low

- [x] [#46](https://github.com/plasticparticle/mneme/issues/46) · **L1 — The approval gate in `handleVerify` fails open on a store error.**
  `server/internal/api/auth.go:179`: `if status, err := s.store.OwnerStatus(...); err == nil && status
  != approved`. If `OwnerStatus` errors, the guard is skipped and a session is minted for a possibly
  pending/rejected owner. The `auth` middleware is a fail-closed backstop on subsequent requests, so
  the window is narrow, but the pattern is fail-open. **Fix:** deny (500/403) on error rather than
  fall through — mirror the middleware at `server.go:116-127`.

- [x] [#47](https://github.com/plasticparticle/mneme/issues/47) · **L2 — No `ReadTimeout` / `WriteTimeout` / `IdleTimeout` on the HTTP server (slowloris).**
  `server/cmd/journald/main.go:137-141` sets only `ReadHeaderTimeout`. `decodeJSON` caps body *size*
  (32 MiB) but not *duration*, so a client can trickle a body or hold idle keep-alives to exhaust
  connections. **Fix:** set `ReadTimeout`, `WriteTimeout`, `IdleTimeout`.

- [x] [#48](https://github.com/plasticparticle/mneme/issues/48) · **L3 — `dangerouslySetInnerHTML` on KaTeX output is only implicitly safe.**
  `apps/client/src/editor/math.tsx:54,195,226`, `apps/client/src/editor/DocPreview.tsx:88,90`.
  `renderLatex` = `katex.renderToString(latex, { throwOnError: false, displayMode })` injected as raw
  HTML. Safe **only** because KaTeX defaults `trust:false` (disabling `\href`/`\includegraphics`/
  `\html*`). An accidental `trust:true` or a default change turns stored content into stored XSS
  (amplified by H2). **Fix:** pass explicit hardening —
  `{ throwOnError:false, trust:false, strict:'ignore', maxExpand:1000, maxSize:500 }`.

- [x] [#49](https://github.com/plasticparticle/mneme/issues/49) · **L4 — Ollama `baseUrl` is used verbatim while badged "on device / nothing leaves the device."**
  `apps/client/src/ai/ollama.ts:24,76`. Decrypted journal excerpts are POSTed to `${baseUrl}/api/chat`
  with no validation that `baseUrl` is loopback/LAN, and AI settings **sync across the vault's
  devices** — so a value set/mistyped on one device silently governs where another ships plaintext,
  while the UI still claims on-device. Same-owner only (not external SSRF), but the privacy label can
  be wrong. **Fix:** validate/normalize to a local default (`127.0.0.1:11434`), warn on non-local
  hosts, and surface the effective host in settings.

- [x] [#50](https://github.com/plasticparticle/mneme/issues/50) · **L5 — Default `CORS_ORIGINS="*"` reflects any Origin.**
  `server/internal/api/cors.go:22-30`, `server/internal/config/config.go:54`. Genuinely safe *today*
  (auth is a `Bearer` header, `Access-Control-Allow-Credentials` is never set), but it is maximally
  permissive by default and would become an account-takeover CORS bug the day anyone adds cookies or
  `Allow-Credentials`. **Fix:** default to an explicit allowlist in production; document the invariant
  "never reflect origin with credentials."

- [x] [#51](https://github.com/plasticparticle/mneme/issues/51) · **L6 — Error messages echo internal parser/DB detail to clients.**
  `server/internal/api/respond.go:27` returns raw JSON decode errors to unauthenticated callers
  (leaks expected field names via `DisallowUnknownFields`, offsets); `server/internal/api/backup.go:119`
  returns raw internal error strings (admin-gated). Minor info disclosure. **Fix:** generic client
  messages, details to server logs only.

- [x] [#52](https://github.com/plasticparticle/mneme/issues/52) · **L7 — `handlePush` processes an unbounded number of entries per request.**
  `server/internal/api/sync.go:14-78`. Body is size-capped (32 MiB) but the `entries` array length is
  not, and each element is an individual `PushEntry` round-trip in a loop — a 32 MiB batch of tiny
  entries becomes a large burst of sequential writes. **Fix:** cap `len(req.Entries)` (mirror
  `maxPullLimit`) and/or batch the writes in a transaction.

### 🔵 Info / accepted

- [x] [#53](https://github.com/plasticparticle/mneme/issues/53) · **I1 — Same-origin co-hosting caveat.** `deploy/web/Caddyfile` serves the app under `/mneme/`
  and comments that "the rest of the origin stays free for other services." Any other app on the same
  **origin** shares this app's `localStorage`, IndexedDB (the sealed-seed keystore), and OPFS. The
  sealed seed is encrypted, but a hostile same-origin page could still register a service worker or
  tamper with storage. **Recommendation:** host Mneme on its own dedicated origin/subdomain.

- [x] [#54](https://github.com/plasticparticle/mneme/issues/54) · **I2 — Relay can roll back / drop / withhold blobs (no freshness guarantee).** Inherent to a
  dumb E2EE relay with cleartext `lww_clock`: the AEAD tag prevents *forgery*, but a malicious relay
  can serve a stale ciphertext or silently omit the newest one. This is an accepted property of the
  design (E2EE protects content, not availability/freshness), worth stating explicitly in the docs.

- [x] [#55](https://github.com/plasticparticle/mneme/issues/55) · **I3 — Prompt-injection surface in the AI assistant.** `apps/client/src/ai/prompts.ts`,
  `ai/context.ts`. Decrypted entry text is interpolated into system prompts; adversarial/imported
  entry text can attempt to steer the model. Contained (output is user-reviewed and inserted as plain
  text), inherent to the feature. Optionally delimit excerpts and instruct the model to treat them as
  data.

- [x] [#56](https://github.com/plasticparticle/mneme/issues/56) · **I4 — Device enumeration via distinct auth error codes.** `server/internal/api/auth.go:124,166`
  return 404 "unknown device" vs 401 "signature does not verify," letting an attacker distinguish
  existing `device_id`s. `device_id` is a pubkey hash and grants nothing without the key — noted for
  completeness.

- [x] [#57](https://github.com/plasticparticle/mneme/issues/57) · **I5 — AI cloud path deliberately crosses the E2EE boundary.** By design and disclosed
  (opt-in, off by default, per-request privacy copy). Not a vuln — a documented tradeoff. Worth
  keeping the disclosure prominent.

---

## Where the approach is unconventional (and a more standard one would be safer)

These are not all "bugs" — they are places where Mneme took a non-mainstream path. Some are
defensible; each is called out so the choice is deliberate.

1. **The account public key is treated as a secret (H1).** Mainstream device-pairing designs
   authenticate *adding a device* with the account/owner key or an existing session. Mneme instead
   relies on the owner **public** key being hard to obtain, which is unusual and brittle — public keys
   leak (backups, the planned QR flow, any future read endpoint). **Best practice:** require an
   owner-key signature or existing-session approval to bind a new device; keep TOFU only for the very
   first device.

2. **Shipping an E2EE app with no CSP (H2).** For an app whose entire confidentiality guarantee rests
   on keys in JS memory, a strict CSP is table stakes and is *named* in the design doc. Its absence is
   the single biggest gap between the documented model and the delivered artifact. **Best practice:**
   CSP is not optional here — treat it as part of the crypto boundary.

3. **Trusting library defaults for URL sanitization (M1, L3).** Both the link parser and the KaTeX
   renderer are safe only because of a third-party default (`isAllowedUri`, `trust:false`). Relying on
   an upstream default for an XSS-critical control is fragile. **Best practice:** validate/allowlist at
   the application layer and pass hardening options explicitly, so an upstream change can't silently
   open a hole.

4. **A hand-rolled Markdown→ProseMirror converter for untrusted input (M1).** Writing a bespoke parser
   for imported (untrusted) Day One content is where the unvalidated-href slipped in. Bespoke is
   reasonable for a narrow known format, but untrusted input deserves an allowlist-based sanitization
   step regardless. **Best practice:** normalize/allowlist marks and attributes after parsing untrusted
   content, independent of the parser.

5. **Reduced Argon2id cost vs. the stated target (M4).** Understandable given pure-JS constraints, but
   it silently lowers the at-rest bar the design advertised. **Best practice:** make the residual risk
   explicit and steer users toward the WebAuthn-PRF unlock, which sidesteps offline brute force
   entirely.

6. **Open-by-default posture (M3, L5).** `REQUIRE_APPROVAL=off`, `CORS_ORIGINS="*"`, and no rate
   limiting are fine for the intended single-tenant/family homelab, but they are permissive defaults
   for anything internet-facing. **Best practice:** secure-by-default, with an explicit "open relay"
   opt-in.

---

## What is done well (verified, no action needed)

- **E2EE core is sound.** XChaCha20-Poly1305 with a random 24-byte nonce and a `[version:1B]` prefix
  on every ciphertext (`crypto/aead.ts`); HKDF-SHA256 domain separation for data/media/ai/identity/
  device keys (`crypto/keys.ts`); per-chunk media AAD binding index+total (`crypto/media.ts`); AAD
  purpose-pinning on sealed seeds and AI settings. `crypto.getRandomValues` / Go `crypto/rand`
  throughout — no `math/rand`.
- **The relay really is a dumb, owner-scoped blob store.** Every authenticated handler reads `owner_id`
  from the session principal, never the request body; every store query is `WHERE owner_id = $1`; media
  and S3 keys embed the authenticated owner — **no cross-tenant IDOR** on sync/media/reminders/account.
- **No SQL injection.** All queries parameterized; the only dynamic SQL is trusted embedded migration
  files.
- **Session/auth mechanics.** 256-bit `crypto/rand` tokens stored only as SHA-256 hashes; single-use
  challenges via atomic delete-with-`expires_at` check; approval status re-read live on every request.
- **Admin + backup surface.** Admin token compared with `subtle.ConstantTimeCompare` and 404 when
  unset; backup filenames gated by an anchored regex (no path traversal); typed-confirmation on
  destructive vault-delete/restore, enforced server-side; archives contain no keys or plaintext.
- **Client egress hygiene.** Geocoder query `encodeURIComponent`'d; static-map tiles are a fixed host
  with floored numeric args and `crossOrigin='anonymous'` (untainted canvas); search highlighting
  renders text nodes; AI chat renders `pre-wrap` plain text; Day One zips are unpacked **in memory
  only** (no filesystem write → no zip-slip); no `eval`/`Function`/`document.write`/`target="_blank"`.
- **AI at rest + on the wire.** API key sealed under an HKDF-derived vault key with AEAD+AAD; requests
  go browser→provider directly (never proxied through the relay); the BYO direct-browser pattern uses
  the correct Anthropic header.

---

### Suggested remediation order
1. **H1** (device-binding authorization) and **H2** (CSP + security headers) — before any
   internet-exposed or multi-user deployment.
2. **M1** (link-href validation), **M2** (orphaned-chunk cleanup — it undercuts the deletion promise).
3. **M3 / M4** (rate limiting + quota; Argon2 cost), then the Low items as hardening.
