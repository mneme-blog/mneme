# Mneme — Security Audit Findings

**Auditor:** Claude (Fable)
**Date:** 2026-07-13
**Scope:** Full repository — Go relay (`server/`), Preact/TS client (`apps/client/`), crypto
(`src/crypto/`), sync (`src/sync/`), deploy config (`docker-compose.yml`, `deploy/`), and the
architecture as described in `CLAUDE.md` §1–§12 and `docs/`.
**Method:** Manual read of every security-critical file plus two parallel deep-dive passes (server
trust boundary; client XSS/SSRF/exfiltration surface).

---

## Overall security rating

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

- [ ] [#57](https://github.com/plasticparticle/mneme/issues/57) · **I5 — AI cloud path deliberately crosses the E2EE boundary.** By design and disclosed
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
