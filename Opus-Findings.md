# Mneme — Security Audit Findings (second pass)

**Auditor:** Claude (Opus 5)
**Date:** 2026-08-05
**Scope:** Full repository, with emphasis on everything built since the first audit
(`Fable-Findings.md`, 2026-07-13, all 18 findings closed 2026-07-31): the guided video
interview and film renderer, recording transcription and the **bundled whisper service**, the
**one-click update mechanism** (relay spool + root host agent), operator backup/restore, the
admin dashboard, journal/AI-settings record sync, and the production deploy
(`docker-compose.prod.yml`, `deploy/`).
**Method:** Manual read of every security-critical file on both sides of the trust boundary —
the Go relay (`server/`), the deploy layer (`deploy/`, compose files, CI workflows), and the
client's crypto/sync/AI/editor paths (`apps/client/src/`) — against the threat model in
CLAUDE.md §1/§3 and `docs/SECURITY.md`.

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

- [ ] **H1 — The bundled speech-to-text server is proxied to every client of the deployment
  with no authentication and no restriction on which of its endpoints are reachable.**
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

- [ ] **M1 — The relay sends no security headers at all, so the admin dashboard is framable and
  runs with no CSP while holding the admin token.**
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

- [ ] **M2 — A record's ciphertext is not bound to the record it belongs to: the relay can move
  one record's encrypted body onto another record's id and the client accepts it.**
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

- [ ] **M3 — Nothing throttles guesses at `ADMIN_TOKEN`.**
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

- [ ] **L1 — The root updater agent executes and sources files out of a checkout the operator's
  own (non-root) account can write.**
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

- [ ] **L2 — The update check follows an arbitrary URL named by the release feed.**
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

- [ ] **L3 — `entry_id` and `reminder_id` are accepted with no length or charset limit.**
  `server/internal/api/sync.go:61` (`if e.EntryID == ""`), `server/internal/api/reminders.go:46`.
  **Problem:** `media_id` is properly constrained (`^[A-Za-z0-9_-]{16,64}$`, media.go:29) because
  it becomes an object-storage key. The oplog's own primary key gets only a non-empty check, so
  an authenticated owner can push records keyed by megabyte-long ids (up to the 32 MiB body
  limit, 500 per request), which are stored, indexed, and echoed back on every pull. Where no
  `QUOTA_BYTES_PER_OWNER` is set — the default — that is unbounded growth in a key column, and
  it is storage the quota's own accounting (which measures ciphertext) does not see.
  **Fix:** validate both ids against the same shape the client actually generates.

- [ ] **L4 — Restore reads archive members with no size bound.**
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

- [ ] **L5 — The stored relay URL is trusted verbatim when read back.**
  `apps/client/src/sync/relay.ts:217-224` (`getStoredRelayUrl` returns the raw localStorage
  string; only the Preferences editor calls `normalizeRelayUrl`).
  **Problem:** validation lives at the write path, so any value that reaches the key another way
  — a hostile same-origin neighbour (§6.15), a stale value from an older build, a synced profile
  — becomes the sync endpoint unchecked. The CSP's `connect-src 'self'` keeps the damage
  theoretical in the standard deployment, and the payload is ciphertext regardless, but a
  setting that decides where the vault is pushed should be validated where it is *used*.
  **Fix:** re-normalize on read and ignore anything that isn't an absolute http(s) URL.

- [ ] **L6 — The admin dashboard interpolates server-supplied strings straight into `innerHTML`.**
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

- [ ] **I1 — `GET /admin` serves the dashboard HTML without authentication** (`admin.go:42-50`)
  whenever `ADMIN_TOKEN` is set — by design: the page prompts for the token and holds no data.
  It does make "this relay has an admin surface" discoverable. Accepted; noted because the
  header work in M1 touches the same handler.

- [ ] **I2 — `ollamaScope` classifies `0.0.0.0` as loopback** (`apps/client/src/ai/ollamaUrl.ts:48`).
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
