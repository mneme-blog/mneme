# Security model

This document describes Mneme's end-to-end encryption, the cryptographic building blocks, and — just
as importantly — the **attack vectors and known weaknesses we are aware of**. Listing a threat here
does not mean it's solved; it means it's tracked. Each item has a status:

- ✅ **Mitigated** — addressed by design or implementation.
- ⚠️ **Accepted** — a conscious tradeoff we are not "fixing" (usually a metadata leak).
- 🔧 **Open** — a real gap with no implementation yet; do not assume protection.

> This is a self-hosted, pre-1.0 project. It has **not** had an external security audit. Treat the
> guarantees below as design intent backed by the current code, not as certified assurances.

---

## 1. What we're protecting, and from whom

**Asset:** the content of journal entries (and, later, media) — the most private thing a person owns.

**Adversary (primary):** the **server operator**. In Mneme's threat model the person running the
relay is *outside* the trust boundary. They control the server, the database, and the network it sees,
and we still don't let them read your journal. This is the whole point — a family self-hosts on a
homelab, and even the admin (a family member) cannot read another member's diary.

**Also considered:** a network attacker (TLS), a thief who steals an unlocked device, and someone who
compromises the server and tries to attack clients through it.

**The trust boundary:**

```
   TRUSTED (your unlocked device)        |   UNTRUSTED (everything else)
   ─────────────────────────────────────┼──────────────────────────────────
   mnemonic, derived keys, plaintext     |   relay (journald), Postgres,
   entries, the client code in RAM       |   MinIO, the network, the admin
                                         |   → sees only ciphertext + metadata
```

**Consequence, by design:** there is **no admin recovery path**. The only recovery anchor is the
12-word mnemonic held by the user. Forgotten mnemonic = data permanently, cryptographically lost.
This is a deliberate availability tradeoff in exchange for confidentiality.

---

## 2. What is and isn't protected

| | Protected (encrypted) | Visible to the server (metadata) |
|---|---|---|
| Entry title & body | ✅ | — |
| Entry labels | ✅ (inside the blob) | — |
| Entry templates | ✅ (ride the entry oplog; kind is inside the ciphertext) | — |
| Journal metadata (name/colour/cover) | ✅ (rides the entry oplog; the journal id itself also stays inside the ciphertext — the wire record id is random) | — |
| AI assistant settings (API key included) | ✅ (ride the entry oplog as an encrypted singleton record) | — |
| Media bytes (video/audio/image/file) | ✅ chunked | size, chunk count |
| Media mime/duration/entry-linkage | ✅ (inside the entry blob) | — |
| — | — | ⚠️ number of entries (≈ writing frequency) |
| — | — | ⚠️ blob sizes |
| — | — | ⚠️ edit timing (via `lww_clock`, see §7) |
| — | — | ⚠️ reminder times (`fire_at` is cleartext) |
| — | — | ⚠️ `owner_id` (links a person's devices together) |
| — | — | ⚠️ approval hint (only on a `REQUIRE_APPROVAL` relay; see §6.8) |
| — | — | ⚠️ IP address / connection timing |

**E2EE protects content, not shape.** The server learns *that* you wrote, roughly *how often*, and
*how big* — never *what*.

The operator's **admin dashboard** (`/admin`, enabled only by `ADMIN_TOKEN`; see
[API.md](./API.md#admin)) surfaces strictly a subset of the right-hand column: per-vault storage
footprints (pseudonymous truncated owner ids) and owner-less daily aggregates (`usage_daily` has no
owner column by design). It adds **no new observation capability** — everything it shows, an admin
with database access could already query.

### The opt-in AI assistant — a deliberate, user-consented exception

The client ships an **off-by-default** AI assistant (`apps/client/src/ai/`): "Ask my journal" Q&A
and editor writing help. It is entirely client-side — **the relay is never involved and gains no
new visibility whatsoever**. But when the user enables the *cloud* backend (their own Anthropic API
key), the entries selected as context for a question are sent, **decrypted, over HTTPS to the model
provider**. That is a voluntary extension of the user's trust boundary to a provider of their
choice — not a weakening of the relay threat model. Guardrails: the feature is opt-in with the
consequence spelled out in the settings UI **and repeated on every surface that uses it** — a badge
on "Ask my journal", the editor action dialog, and the guided interview states where the text goes
each time, so the disclosure is not something you saw once during setup (`ui/ProviderBadge.tsx`,
deliberately one component so the three surfaces cannot drift apart); a fully local backend (Ollama) is offered where nothing
leaves the device — and the settings sheet always shows the **effective destination** of that
backend, because `baseUrl` is free text that syncs across the vault's devices, so a value typed on
one device would otherwise silently govern where another ships plaintext under an "on this device"
badge. A non-loopback address swaps the badge and adds a warning; an unusable one falls back to
`127.0.0.1:11434` rather than being used verbatim (`ai/ollamaUrl.ts`); the API key is stored sealed (XChaCha20 under an HKDF key derived from the vault
seed, `ai/settings.ts` — only openable while unlocked, re-sealed on phrase rotation, cleared on
vault deletion); chat transcripts are memory-only and never persisted or synced. The settings
themselves (API key included) sync to the vault's other devices as an encrypted oplog record —
indistinguishable from an entry to the relay, which still cannot use or read the key. The one invariant
that must never break: **journal plaintext must never be routed through the relay as an AI proxy.**

**Recording transcription** (`ai/transcribe.ts`) follows the same rules. The "Transcribe" actions on
video/audio recordings send the **decrypted media bytes** browser → a speech-to-text server (any
endpoint speaking the OpenAI `/v1/audio/transcriptions` shape) directly — never via the relay
*process*. The standard deployment **bundles** a whisper container (`whisper` in
`docker-compose.prod.yml`, MIT-licensed stack) proxied under the app's own origin at `/whisper`, and
the client defaults to it. Its model is installed once by the `whisper-model` one-shot beside it —
Speaches does not fetch models on demand, and an uninstalled model 404s every transcription; the
settings sheet's **Check server** action reports that case and can trigger the same install (a
model-listing request, never a recording). Be precise about what that means: the relay software still never sees
audio or text, but the **operator's machine** now runs the transcriber — from any device other than
the server itself (phones, always), the decrypted recording crosses the network to that box. The UI
refuses to let this be implicit twice over: the settings sheet badges any non-loopback destination
"leaves this device" and names the resolved host, and **every Transcribe action shows a per-use
confirmation naming the destination** before any audio is sent (a loopback server runs without the
dialog — warning for the on-device case would train users to click through). A truly-local loopback
server remains fully covered by the shipped CSP (`connect-src http://localhost:*
http://127.0.0.1:*`); a third-party endpoint needs `CSP_CONNECT_EXTRA`. The resulting transcript is
stored **inside the encrypted entry body** (media node attrs / video-interview cards), so it syncs
like any entry content, is searchable, feeds Ask-my-journal — and the relay never sees it. Because it
is ordinary entry content, it is also **editable by hand** (the "Edit" action next to a shown
transcript; emptying the box removes it) — a correction never leaves the device, since fixing text
involves no server at all.

### Location snapshots — a one-time, per-insert exception

The editor can embed a **location/map** in an entry (`apps/client/src/location/`, `editor/location.tsx`).
Like the AI assistant, **the relay gains no new visibility** — it still only ever stores the encrypted
entry body and an opaque encrypted image blob. The deliberate exception is at *creation time only*: to
turn an address into coordinates the client calls **OpenStreetMap Nominatim** (the typed address
leaves the device), and to draw the map it fetches **OpenStreetMap raster tiles** (the chosen
coordinates leak to the tile CDN, as tile indices). Mitigations: this is opt-in per insert with the
consequence stated in the composer UI; current-location and raw-coordinate entry avoid the geocoder
entirely; and the map is **frozen into a static image** at insert time, so opening the entry later — or
on another device — decrypts that stored image and makes **no further third-party requests**. There is
no live/streaming map. Both hosts are named explicitly in the shipped CSP (§6.2) — `img-src` for the
tile CDN, `connect-src` for the geocoder — so this egress is enumerated rather than incidental.

### The guided video interview — no new exception at all

The on-camera interview (`apps/client/src/ui/VideoInterview.tsx`) is worth stating explicitly because
it *sounds* like it should leak something, and does not.

- **The model never sees or hears an answer.** It is asked once, at the start of a session, to plan a
  list of questions; that request carries the interview type's prompt and — as with the written
  interview — excerpts of previous entries carrying the same label, under the same opt-in AI terms
  above. The recorded clips are never sent anywhere for analysis. There is deliberately **no
  speech-to-text**: the browser's `SpeechRecognition` API streams audio to Google/Apple servers, which
  would be a silent, unconsented export of the most intimate content in the app.
- **Recording is fully offline.** After the plan call the session makes no network requests at all.
- **The relay sees no more than for any other entry.** The question texts, the pairing of question to
  clip, and the interview type's name all live inside the encrypted entry body; the clips and the
  rendered film are ordinary media rows, so the relay stores opaque chunks under random media ids.
- **Stitching the film happens on the device.** `apps/client/src/video/` decodes, re-encodes and
  muxes locally via WebCodecs (or a canvas + `MediaRecorder` fallback). No media service is involved,
  nothing is uploaded to produce it, and it needs no new CSP directive — the existing
  `worker-src 'self' blob:` and `media-src 'self' blob:` already cover it, and it requires no
  COOP/COEP cross-origin isolation, so the wa-sqlite VFS choice (§6.2) is unaffected.

The one operational consequence to be aware of is **size, not secrecy**: a rendered film is stored
alongside the answer clips it was made from, so a session's footprint roughly doubles once rendered —
relevant if the relay sets `QUOTA_BYTES_PER_OWNER` (§6.9). The card offers "Delete the source clips"
for exactly this.

---

## 3. Cryptographic building blocks

> The full crypto deep-dive — key derivation tree, the ciphertext envelope, media chunking, at-rest
> seals, and rotation — lives in **[ENCRYPTION.md](./ENCRYPTION.md)**. This section is the threat-model
> summary.

All cryptography runs **in the client**, once, for every shell (the PWA has no Rust/Go to host it).
The server does exactly one cryptographic operation: **verifying an Ed25519 signature** for auth — it
never decrypts anything.

| Purpose | Primitive | Library |
|---|---|---|
| Recovery phrase | BIP39, 128-bit, 12 words | `@scure/bip39` |
| Seed → keys | HKDF-SHA256 (salt `"journal-v1"`) | `@noble/hashes` |
| Entry encryption | XChaCha20-Poly1305 (AEAD), random 24-byte nonce | `@noble/ciphers` |
| Owner identity | X25519 (for future sealed-box pairing) | `@noble/curves` |
| Device auth | Ed25519 (challenge-response signatures) | `@noble/curves` |
| Hashing / IDs | SHA-256 | `@noble/hashes` |

**Why `@noble`/`@scure` (paulmillr):** audited, dependency-light, synchronous (no wasm init), and
tree-shakeable. This is a **recorded override** of the original "libsodium-wasm" decision
(CLAUDE.md §3, dated 2026-06-09); the §6 primitives themselves are unchanged.

**Why XChaCha20-Poly1305, not AES-GCM:** the 192-bit (24-byte) nonce makes random-nonce collisions
negligible, so we never need a nonce counter or nonce-management discipline — a frequent source of
catastrophic AEAD failures.

**Ciphertext envelope** (`[version:1B][nonce:24B][ct+tag]`): every blob is version-prefixed so the
primitive can be rotated later without ambiguity. See [ARCHITECTURE.md §5](./ARCHITECTURE.md).

---

## 4. Key lifecycle & at-rest storage

```
mnemonic ──derive──▶ {data_key, owner X25519, device Ed25519}  (in RAM only)
```

- **In memory while unlocked is unavoidable** for any client-side crypto — the keys must exist in
  process memory to encrypt/decrypt.
- **Keys at rest, today:** _nothing is persisted by default_ — the identity lives in memory only and
  you re-enter the mnemonic on every cold start. ✅ Optionally (an explicit onboarding choice, "stay
  signed in on this device"), the BIP39 seed is sealed under an **Argon2id** passphrase-derived key
  (`crypto/seedlock.ts`: Argon2id 128 MiB / t=2 / p=1 → XChaCha20-Poly1305 with the standard
  version-byte envelope and a purpose-binding AAD) and stored in IndexedDB (`platform/keystore.ts`).
  Cold start then asks for the passphrase instead of the phrase; a wrong passphrase fails the AEAD
  tag. KDF parameters are stored inside the record, so they can be raised later without breaking old
  seals. Signing in with the phrase but skipping the passphrase clears any stored seal; phrase
  **rotation re-seals the new seed** under the kept wrap key (and clears the seal if that fails — a
  record that would "unlock" into the wiped old identity is worse than none). The sealed record is an
  offline-brute-forceable artifact for whoever obtains the disk; the slow KDF and the passphrase's
  strength are all that stand in the way, and the UI says so. The cost was raised from 64 MiB / t=3
  to 128 MiB / t=2 ([#45](https://github.com/plasticparticle/mneme/issues/45)) — double the peak
  memory, which is what limits a GPU attacker's parallelism, for ~2.4 s of unlock time on desktop.
  §6's nominal 256 MiB target assumes native code; in pure JS it costs seconds more and risks an
  out-of-memory kill in a mobile browser tab. **Where a device supports it, the security-key seal
  below is the better choice** — it has no offline attack at all — and it is listed first in
  Preferences → Vault → Device unlock for that reason. **Auto-lock after 15 min of
  inactivity** drops the in-memory keys whenever a seal exists; a manual "Lock journal" control
  exists on both layouts.
- **Security-key seal (FIDO2/WebAuthn PRF):** ✅ as an alternative to the passphrase, the seed can be
  sealed under a secret obtained from a FIDO2 authenticator (YubiKey, platform passkey) via the
  WebAuthn **PRF extension** (`platform/webauthn.ts` runs the ceremonies; `crypto/seedlock.ts` turns
  the 32-byte PRF output into the wrap key via HKDF, sealing with the same version-byte envelope
  under a method-specific AAD, record `v:2`). Unlike the passphrase record this is **not offline
  brute-forceable** — the secret only exists inside the authenticator. It is strictly a
  device-unlock convenience: the mnemonic stays the only account/recovery anchor, and "Use my
  recovery phrase instead" always works (lost/broken key, or the PWA moving domains — the credential
  is rpId-bound). One seal method at a time; switching (passphrase ⇄ security key ⇄ off) lives in
  Preferences → Vault → "Device unlock" and replaces the previous seal only after the new one
  succeeds. Rotation re-seals PRF records under the kept wrap key with **no extra ceremony**.
- **Data at rest, today:** the journal itself **is persisted in plaintext** on the device — a
  per-owner wa-sqlite database in the browser's origin-private file system (OPFS) holds entries,
  media bytes, and templates (CLAUDE.md §5a: "alles im Klartext, weil nur auf dem entsperrten
  Gerät"). This is the deliberate local-first design, but it means device-level protection (OS disk
  encryption, browser-profile isolation) is what stands between a device thief and the data — see
  §6.11. ⚠️ **Accepted** (with at-rest hardening tracked below).
- **At rest, planned:** Tauri → OS keychain (Stronghold) unlocked by OS biometrics. (CLAUDE.md §6.)
  🔧 **Open** — the PWA half (Argon2id-sealed seed in IndexedDB, or nothing stored) is ✅ done, above.

The device key is derived from the seed (`info="device"`) rather than generated per-device, so the
mnemonic alone fully reconstructs a working device. (Tradeoff: today there is effectively one logical
device identity per mnemonic; true per-device keys are a later refinement.)

**Phrase rotation (leaked-mnemonic response).** ✅ A mnemonic cannot be changed in place — every key
and the `owner_id` derive from it — so "Replace recovery phrase" (sidebar/settings) performs a full
migration (`sync/rotate.ts`): generate a new phrase, re-encrypt every entry and media object under
the new keys, push them as a brand-new owner, then `DELETE /v1/account` on the old owner. The old
account is wiped only after the vault is fully stored under the new one; any earlier failure leaves
it intact, and retrying with the same new phrase is idempotent. After rotation the leaked phrase
authenticates (TOFU) into an *empty* vault, the old session tokens are dead, and the old per-owner
local OPFS database is destroyed. Caveat: rotation removes ciphertext going forward — it cannot
retract copies an attacker already exfiltrated while the old phrase was valid.

---

## 5. Authentication & tenant isolation

- **Registration** binds an `owner_id` (from the seed) to a device pubkey. Creating a vault is
  **trust-on-first-use**; joining an existing one requires a signature by the owner identity key,
  which only the seed can produce (§6.5). ✅
- **Auth** is Ed25519 challenge-response: the relay issues a random challenge (2-min, single-use), the
  device signs it, the relay verifies against the stored device pubkey and issues a random **session
  token** (default 24 h). The token is stored only as `sha256(token)` — a database leak does not yield
  usable tokens. ✅
- **Isolation:** every authenticated handler derives `owner_id` from the session principal, never from
  the request body, so one tenant can't touch another's rows. ✅ (Covered by the `e2e` test.)

---

## 6. Attack vectors

### 6.1 Malicious or compromised server serving client code — 🔧 Open (the big one)
The classic weakness of *all* browser-delivered E2EE: if the same server that stores your ciphertext
also serves the web app, a compromised server can ship **malicious JavaScript that exfiltrates keys or
plaintext** the moment you unlock. End-to-end encryption can't protect you from a backdoored client.
- **Mitigations (planned):** ship the **Tauri shells** (signed, updated out-of-band) as the serious
  client; serve the PWA from a host *separate* from the relay; Subresource Integrity; reproducible
  builds; a strict CSP. **None are in place yet.** For now, run the relay and the app from sources you
  control.

### 6.2 XSS / supply-chain in the client — ⚠️ Reduced
Keys live in RAM while unlocked, so any script injection (an XSS hole, a hostile npm dependency) can
read them — and with them every plaintext entry, unrecoverably.
- **Mitigations:** a strict **Content-Security-Policy** ✅ (see below), auto-lock on inactivity ✅
  (15 min + manual lock), keys never written to the DOM or logs ✅, pinned dependencies + lockfile +
  `pnpm audit` (lockfile committed; audit not yet in CI), minimal vetted crypto deps (`@noble`).

**The CSP** is defined once in `apps/client/csp.js` and shipped twice: as a response header from the
hosting layer (`deploy/web/Caddyfile` — authoritative, and the only place `frame-ancestors` counts)
and as a `<meta http-equiv>` injected into the production build (the fallback for any other host).
`pnpm --filter client csp` prints the current string; keep the two in sync, because browsers
*intersect* multiple policies and a drifted pair silently over-restricts.

`script-src` is `'self' 'wasm-unsafe-eval'` — no `'unsafe-inline'`, no `'unsafe-eval'`. The wasm token
is required by wa-sqlite and permits WebAssembly compilation only, not `eval`. `style-src` does carry
`'unsafe-inline'`: the UI styles via inline attributes and KaTeX emits inline styles, so this is a
known, scoped concession that weakens CSS-injection defence but not script execution.

Egress is enumerated rather than open: `connect-src` allows the app's own origin, `api.anthropic.com`
(BYO-key AI), `nominatim.openstreetmap.org` (address search), and loopback Ollama; tiles are
`img-src` only. A relay or Ollama on another origin must be added explicitly via `CSP_CONNECT_EXTRA`
(build- or deploy-time) — the friction is the point. Alongside it the hosting layer sends
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a
`Permissions-Policy` that keeps camera/microphone/geolocation to `self` and denies the rest.

Residual risk: this does not defend against a **compromised server serving malicious app code**
(§6.1) — that server also controls the policy.

### 6.3 Server reads content — ✅ Mitigated
The server stores opaque `BYTEA` and compares only integers. It holds no keys and does no decryption.
Confidentiality does not depend on the server behaving — only availability does (§6.7).

### 6.4 Network attacker (MITM) — ⚠️/🔧
Content is already ciphertext, but tokens and metadata transit the wire. **TLS is required in
production.** Dev runs over plain HTTP on localhost. CORS is configurable (`CORS_ORIGINS`); the dev
default reflects any origin and must be tightened in production. 🔧 TLS termination is deployment's job
and not yet documented as enforced.

### 6.5 Rogue device registration / data poisoning — ✅ Mitigated
Registration used to prove possession of the *device* key only, so anyone who learned your
`owner_pubkey` could bind a device of their own to your vault and then read the ciphertext, overwrite
every entry with a high `lww_clock`, tombstone them, or `DELETE /v1/account` the whole thing. They
could never decrypt (no seed), so confidentiality held — but integrity and availability did not.

Registration now carries a **second signature by the owner identity key**, an Ed25519 key derived from
the same seed (`HKDF info="identity-sign"`). The relay pins that key when the vault is created and
refuses any later registration not signed by it, so trust-on-first-use survives only for *creating* a
vault, not for joining one. The owner public key is back to being an ordinary public key.

Owners that predate the check are grandfathered once, and only from a device already bound to them —
device keys are seed-derived, so an honest client always has one and an attacker with just the owner
public key does not. See docs/API.md `POST /v1/register`; regression test
`server/e2e/binding_e2e_test.go`.

**Abuse controls.** The three unauthenticated endpoints are throttled per client IP (token bucket,
in-process; `RATE_LIMIT_AUTH_PER_MINUTE` / `RATE_LIMIT_AUTH_BURST`, `0` disables), which bounds
anonymous owner creation and `auth_challenges` flooding. A per-owner storage quota
(`QUOTA_BYTES_PER_OWNER`, unlimited by default) bounds what a single authenticated owner can consume;
tombstones are exempt so an over-quota vault can still delete. Both are best-effort backstops sized
for the intended homelab scale (§7) — a distributed attacker belongs at the reverse proxy, and the
quota is a pre-flight check rather than a transactional reservation, so a concurrent burst can
overshoot by about one batch.

### 6.6 Replay — ✅ Mitigated
Challenges are single-use and expire (2 min); sessions expire. Replaying a `sync/push` is harmless —
LWW makes it idempotent (a non-newer clock is ignored).

### 6.7 Server rolls back, withholds, or drops data — ⚠️ Accepted (no freshness guarantee)
**There is no freshness guarantee.** The AEAD tag stops the relay from *forging* or *altering* a
blob — any tampering fails decryption — but it says nothing about *which* blob you are handed, or
whether you are handed one at all. A malicious relay can:

- **serve a stale version** of an entry instead of the newest one (a rollback), because `lww_clock`
  is cleartext and unauthenticated, so the relay knows exactly which ciphertext is older;
- **omit an entry entirely** from a `sync/pull` — a client that has never seen it cannot know it
  should exist;
- **drop or reorder** records, or simply stop answering.

This is inherent to a dumb E2EE blob relay and is **accepted**, not solved. Detecting it would need
the client to authenticate the *set* of records — a signed manifest, a hash chain, or a Merkle root
over the oplog carried inside the ciphertext — which is real design work and not currently built.

What limits the damage in practice: the local OPFS database is the source of truth (§5a), so an
unlocked device keeps its data regardless of what the relay says; every device that has synced holds
an independent copy; and a rollback cannot produce content you never wrote, only re-show content you
did. Related: §6.9, where the cleartext `lww_clock` is what makes targeted rollback precise.

### 6.8 Metadata & traffic analysis — ⚠️ Accepted
Entry counts, blob sizes, edit cadence, reminder times, and `owner_id`↔device linkage are visible (§2).
We do not pad, batch, or cover-traffic these. E2EE protects content, not shape.

**Approval hint** (only when the operator runs `REQUIRE_APPROVAL`): at registration the client sends
a short `[a-z0-9-]{0,32}` code it derives one-way from the seed (e.g. `amber-otter-07`) so the
operator can tell which *pending* vault to approve. It is the one user-adjacent, non-ciphertext string
the relay stores — a deliberate, minimal accepted leak. It is **not** free text (the charset is
enforced server-side, so it can't smuggle PII or markup — also closing stored-XSS in the dashboard),
**not** a secret, and reveals nothing about the seed (a one-way projection, exactly like `owner_id`).
`REQUIRE_APPROVAL` itself is an access-control feature, not a confidentiality one: it stops *strangers
storing* their journals on your relay (see API.md / server README), enforced at the API — approve/
reject at `/admin`, immediate on the next request. It does not change what the operator can see of an
approved vault (still nothing but §2 metadata).

### 6.9 `lww_clock` leaks edit timestamps — 🔧 Open (sharper than "edit frequency")
`lww_clock` is currently wall-clock `Date.now()` in milliseconds, so the server learns the **real time**
of each edit, not merely how often you write. CLAUDE.md §3 accepts "edit frequency"; wall-clock is a bit
more. Moving to a **Hybrid Logical Clock or Lamport counter** (CLAUDE.md §12 `OPEN`) would remove the
real-time signal while preserving LWW ordering.

### 6.10 Entry IDs leaking chronology — ✅ Mitigated
`entry_id` is a **random 128-bit hex** value (`src/sync/ids.ts`), deliberately **not** a ULID or any
timestamp-encoded id, because the relay sees ids in cleartext and a time-encoded id would leak writing
order. (Note: this intentionally diverges from the "ULID" wording in CLAUDE.md §5a/§11 — the leak-guard
in §3 wins.)

### 6.11 Stolen unlocked device / local exposure — ⚠️/🔧
If a device is stolen while unlocked, the journal is exposed (true of any app). The local wa-sqlite
DB additionally persists the decrypted vault in OPFS (§4), so anyone with access to the OS user
account / browser profile can read it even when the app is "locked" — OS-level disk encryption and
a non-shared user account are the current line of defense. Auto-lock (15 min inactivity when a sealed
seed exists) and the Argon2id seed seal (§4) are in; at-rest encryption of the local *database* is
not. Also beware shoulder-surfing during the recovery-phrase
reveal, clipboard exposure on "copy mnemonic", and screenshots — the UI nudges ("make sure no one is
watching") but cannot enforce these.

### 6.12 Lost mnemonic — ⚠️ Accepted (by design)
No recovery path. This is the deliberate cost of "the admin cannot recover." Users must back up the
phrase offline.

### 6.13 Weak randomness — ✅ Mitigated
All randomness comes from the platform CSPRNG (`crypto.getRandomValues`); mnemonic entropy is 128-bit
BIP39.

### 6.15 Same-origin co-hosting — ⚠️ Accepted (deployment choice)
The browser's isolation boundary is the **origin** (scheme + host + port), not the path. The bundled
Caddy config serves Mneme under `/mneme/` and notes that "the rest of the origin stays free for other
services" — that is a routing convenience, and it must not be read as isolation. Anything else served
from the same origin shares:

- `localStorage` — theme, language, the stored relay URL;
- **IndexedDB** — the sealed-seed keystore and the sealed AI settings;
- **OPFS** — the per-owner SQLite database, which holds entries in *plaintext* (§5a: the local DB is
  the decrypted source of truth);
- the service-worker registration scope, so a neighbour can register a worker that intercepts
  Mneme's own requests and serve replaced application code.

The seals are encrypted and a neighbour cannot read the seed from them directly, but plaintext
entries in OPFS need no key at all, and worker-level code replacement defeats E2EE the same way a
compromised server does (§6.1).

**Recommendation: give Mneme its own dedicated origin — a subdomain of its own — whenever anything
else is served from the same host.** A path prefix on a shared origin is fine only when you control
every other app on that origin and trust it as much as you trust Mneme.

### 6.16 Prompt injection in the AI assistant — ⚠️ Accepted (contained)
Every AI surface interpolates decrypted entry text into a prompt, and that text is **not necessarily
something the user wrote**: a Day One import carries whatever was in the archive, and entries quote
emails, web pages, and anything else that gets pasted. So `IGNORE THE ABOVE…` inside an entry is a
plausible accident as much as an attack — and with nothing marking where data ends, it reads to the
model exactly like an instruction from the app.

**Mitigation** (`ai/fence.ts`): journal content is wrapped in a fence whose markers carry a **random
per-request token** (`<journal:9f3a21c4>` … `</journal:9f3a21c4>`). An entry can contain the literal
string `</journal>`, but not a marker bearing a token generated after it was written; occurrences of
the token in the body are neutralized as a second line of defence. The system prompt then states once,
naming the concrete markers, that fenced content is data and can never redefine the rules. Titles and
labels go inside the fence too, rather than sitting outside it as trusted-looking prompt structure.

**Why this stays "accepted" rather than "mitigated":** prompt injection has no complete fix. The
model may still be steered into an odd answer. What bounds the damage is the shape of the feature:
there is no tool-calling and no agentic loop — `AiProvider.chat` only streams text — output is
inserted as **plain text** after the user reviews it, and a synthesized interview entry is shown for
approval before it is ever saved. A hostile entry can influence what the assistant *says*, not what
the app *does*. Covered by `scripts/ai-roundtrip.ts`.

### 6.14 Operator backups — ⚠️ Accepted (aggregation, not a new leak)
The operator backup feature (`BACKUP_DIR`, the `/admin/backups` surface, and the `journald
backup`/`restore` CLI) writes a single archive of **every vault's opaque ciphertext blobs + media
chunks**. Crucially, a backup contains **no keys and no plaintext** — the relay never had any — so it
neither weakens nor strengthens E2EE: an attacker who steals an archive learns exactly what an attacker
who steals the Postgres DB + object bucket already could (the §2/§6.8 metadata, plus the ciphertext
they still cannot decrypt). What changes is **aggregation and portability**: one file now concentrates
all vaults' data, including the accepted metadata, and is easy to copy off-box. Treat archives with the
same care as the database itself — restrict the directory (written `0700`/files `0600`), and encrypt
them at rest (e.g. age/GPG) before moving them somewhere less trusted. `sessions` and `auth_challenges`
(bearer-token hashes, single-use challenges) are deliberately **excluded** so a restore cannot
resurrect a stale credential. Restore is destructive (it replaces all relay data) and is gated behind
a typed `{"confirm":"restore"}` on the HTTP path and a stdin prompt on the CLI; archive names on the
HTTP download/restore/delete paths are validated against a strict regex (the path-traversal boundary).

### 6.17 One-click updates — ⚠️ Accepted (opt-in privilege escalation, deliberately bounded)
The `/admin` dashboard can apply a release (`UPDATE_SPOOL_DIR` + the host agent in `deploy/updater/`).
State it plainly: **with this enabled, whoever holds `ADMIN_TOKEN` can cause the host to pull and run
new code and restart the stack.** That is a privilege escalation from "read aggregate stats" to
"replace the running software", and it is the point of the feature — but it is why the feature is
**off by default and requires a deliberate host-side install**, not merely a config flag.

The escalation is bounded by construction rather than by trust in the relay:

- **The relay holds no host access.** No Docker socket is mounted into any container. The relay writes
  a JSON request into a shared directory; a root-owned systemd unit on the host reads it. If the relay
  is fully compromised, the attacker gains the ability to *ask*, not to *act*.
- **The request vocabulary is two verbs.** `update` (with a version tag) and `rollback`. No image,
  registry, path, command, or flag is expressible. The tag is validated against a strict pattern on
  **both** sides — the agent re-validates rather than trusting that the relay did — and is pasted
  into a fixed image reference against a fixed registry. Two tag shapes exist: release semver
  (`^v[0-9]+\.[0-9]+\.[0-9]+…$`) and, since the dashboard gained a "Switch to main" channel,
  immutable per-commit main builds (`main-[0-9a-f]{7,40}`, published by CI only for commits that
  passed on main; the bare moving tag `main` is deliberately rejected). So the worst a compromised
  relay achieves is a **downgrade to a published Mneme release or to any past CI-published main
  build**, which is a real attack (it can re-open a fixed vulnerability, e.g. rolling back past
  0004's registration binding, and old main commits include states no release ever shipped) but not
  arbitrary code execution — every requestable image is code that was on this repository's main.
- **Both actions need a typed confirmation** enforced server-side, so a stray authenticated request
  cannot restart the stack.
- **Every update takes a full backup first**, and a release that fails to become healthy is rolled
  back automatically.

Residual risks worth naming: a downgrade attack as above (mitigated only by protecting `ADMIN_TOKEN`
— rotate it, and consider leaving updates off on an internet-reachable relay); images are pulled by
**tag, not digest**, so the registry and the transport are trusted (GHCR over TLS); and the agent runs
as root, so a bug in the agent script is a host-level bug. The conservative posture is unchanged and
fully supported: leave `UPDATE_SPOOL_DIR` unset and update on the host by hand.

Note also that a server-side rollback does **not** roll back client-side state: local device databases
migrate forward-only too, so a device that has opened the newer client stays migrated (§11).

### 6.18 The bundled speech-to-text service — ⚠️ Accepted (unauthenticated compute, allowlisted)
The deployment ships a whisper server (the `whisper` compose service) and Caddy proxies it at
`/whisper` so the client's default transcription endpoint is same-origin — which is what makes it
work with no CSP or CORS configuration. **That route is unauthenticated, and it cannot be otherwise:**
the relay's device auth belongs to the relay, and the client posts audio here directly (browser →
whisper, never through the relay — §2). Nothing about E2EE changes: the recording is decrypted on the
device that owns it, sent to a server the deployment itself runs, and the transcript comes back into
the encrypted entry body. But it means the origin exposes one endpoint that is **not** owner-scoped,
throttled, or quota'd.

What is done about it: the proxy forwards only the three endpoints the app calls — `POST
/v1/audio/transcriptions` (with a 512 MB body cap), `GET /v1/models`, and `POST /v1/models/{id}`
**restricted to the single model the deployment configures** (`WHISPER_MODEL`). Everything else the
image serves — model deletion, text-to-speech, its own UI — is a 404. Without that allowlist, the
install endpoint alone is "fetch any Hugging Face repository onto my server" for any passer-by, and
the transcription endpoint is a CPU-exhaustion primitive with no token bucket in front of it.

What remains, and is accepted: **anyone who can reach the site can spend transcription CPU.** On the
intended LAN deployment that is the same trust boundary as everything else on the origin. A site
reachable from the internet should put authentication in front of `/whisper`, or drop the `whisper`
and `whisper-model` services and point the client's transcription setting at a server of its own —
the feature degrades cleanly to "off" when the endpoint is absent.

---

## 7. Known weaknesses / hardening backlog

In rough priority order:

1. 🔧 **Ship a tamper-resistant client** (Tauri, signed) and/or serve the PWA separately from the relay
   with SRI + strict CSP — closes §6.1, the most fundamental gap for browser E2EE.
2. ✅ **Content-Security-Policy** — shipped as a Caddy response header + a `<meta>` fallback in the
   build, from one definition in `apps/client/csp.js` (§6.2). A relay or Ollama that isn't
   same-origin/loopback needs `CSP_CONNECT_EXTRA`.
3. 🔧 **At-rest key protection, Tauri half** (OS keychain) — the PWA's Argon2id seal is ✅ in — §4, §6.11.
4. ✅ **Harden device registration** (owner-key signature proves seed possession) and ✅ **rate
   limiting + per-owner storage quota** (`RATE_LIMIT_AUTH_*`, `QUOTA_BYTES_PER_OWNER`) — §6.5.
5. 🔧 **HLC/Lamport `lww_clock`** to stop leaking real edit times — §6.9.
6. 🔧 **Production deployment guide**: enforce TLS, set `CORS_ORIGINS` to the real client origin, rotate
   the MinIO/Postgres dev credentials.
7. 🔧 **External security review** before any 1.0 / real-data use.

---

## 7b. Internal code review — findings & status

A code-level audit of `apps/client/` (crypto, sync, local DB, onboarding) and `server/` (auth, sync,
store, reminders) was performed on **2026-06-09** against the threat model in CLAUDE.md §1/§3. It was a
point-in-time review of a pre-1.0 codebase; the findings are folded in here (rather than kept as a
separate document) so this file stays the single source of security truth. Statuses are **current**,
not as-of-review — two findings have since been addressed.

Severities reflect impact **within the stated threat model** (the relay operator is out-of-trust, so
"a malicious relay can do X" is a real finding unless §3 lists X as an accepted leak).

| # | Sev | Finding | Status | Tracked in |
|---|-----|---------|--------|-----------|
| 1 | High | AEAD does not authenticate `entry_id` / `deleted` / `lww_clock` — a hostile relay can relabel, resurrect, or pin entries (media chunks *do* bind AAD; entry bodies don't) | 🔧 Open | §6.1, [ENCRYPTION.md §3](./ENCRYPTION.md) |
| 2 | High | No Content-Security-Policy — the design's primary mitigation for in-memory keys is absent | ✅ **Fixed** — strict CSP + security headers ([#41](https://github.com/plasticparticle/mneme/issues/41)) | §6.2, §7.2 |
| 3 | High | Owner binding at `/v1/register` is unauthenticated (anyone with the owner pubkey can attach a device → write/DoS) | ✅ **Fixed** — registration requires an owner-identity-key signature ([#40](https://github.com/plasticparticle/mneme/issues/40)) | §6.5 |
| 4 | Med | No auto-lock / key-lifetime limit | ✅ **Fixed** — 15-min inactivity auto-lock + manual lock (§4, §6.11) | §4 |
| 5 | Med | `lww_clock` is attacker-controllable client wall-clock (future-dated writes pin an entry) | 🔧 Open | §6.9 |
| 6 | Med | No rate limiting / abuse controls on any endpoint | ✅ **Fixed** — per-IP throttle on the auth endpoints + per-owner storage quota ([#44](https://github.com/plasticparticle/mneme/issues/44)) | §6.5, §7.4 |
| 7 | Med | Relay can silently roll back / drop / reorder the record set (no freshness proof) | ⚠️ **Accepted & documented** — inherent to a dumb E2EE relay; a signed manifest / hash chain is unbuilt ([#54](https://github.com/plasticparticle/mneme/issues/54)) | §6.7 |
| 8 | Low | Recovery phrase can be copied to the system clipboard | ⚠️ Accepted (UI-nudged; convenience vs. exposure) | §6.11 |
| 9 | Low | External Google Fonts (privacy leak, no SRI, weakens CSP story) | ✅ **Fixed** — fonts self-hosted via `@fontsource-variable` | — |
| 10 | Low | Device/owner enumeration via distinct error responses | 🔧 Open | §6.5 |
| 11 | Low | Relay serves plain HTTP, no HSTS; TLS is deployment-dependent | 🔧 Open (Caddy prod stack terminates TLS — [DEPLOYMENT.md](./DEPLOYMENT.md)) | §6.4 |
| 12 | Info | Session revocation absent; `CORS_ORIGINS` defaults to `*`; dev secrets shipped | 🔧 Open (override in prod) | §7.6 |

**Positives recorded at review time (still true):** all Postgres access uses parameterized `pgx`
queries; local SQLite `search()` escapes `LIKE` wildcards; session tokens are random 32-byte values
stored only as SHA-256 hashes; challenges are single-use and TTL-bounded; the ciphertext format carries
a version byte from day one; entry IDs are random, not time-encoded.

**Suggested remediation order:** finding 1 (AEAD framing — cheap, also hardens 5 and 7) → finding 2
(CSP) → finding 3 (authenticated owner binding) → findings 5/6 (clock sanity, rate limiting) →
findings 10–12 (polish).

---

## 8. Reporting

No private data should ever reach the server in plaintext — if you find a way it can, that's a
top-severity bug. Until a dedicated channel exists, report security issues privately to the maintaine. 
Report to [weber.lars+mnemeSecurity@gmail.com](weber.lars+mnemeSecurity@gmail.com)
rather than opening a public issue.
