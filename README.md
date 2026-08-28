# Mneme

> An open-source, local-first, **end-to-end-encrypted** journal. Your thoughts are encrypted on your
> device before they go anywhere, and the server is too clueless to read them if it tried.

Mneme is a calm, paper-coloured notebook for the unfiltered version of you — the fears, the
half-formed ideas, the things you'd never say out loud. That is exactly the data a multi-billion-euro
company would most like to have, so the design starts from one hard rule: **the server can never read
your journal.** No accounts to harvest, no plaintext on anyone's disk but yours, no telemetry. Run it
on a Raspberry Pi in your closet and owe nobody an explanation.

It runs in your browser today (native desktop and mobile shells are on the way), keeps the real
database on your own device, and syncs through a relay that only ever sees opaque ciphertext.

And when the blank page wins — as it does for most people, most of the time — a **local AI model**
sits you down for a structured interview instead: one reflective question at a time, then it drafts
the whole entry for you to keep or edit. In writing, or on camera. Nothing leaves your machine.

![The Mneme editor on desktop: a three-pane layout with notebooks, an entry list, and a serif writing surface showing rich text, inline math, and lists.](docs/screenshots/desktop-editor.png)

<p align="center">
  <img src="docs/screenshots/mobile-journal.png" alt="A notebook on mobile: the Tutorial journal's entry timeline with previews and dates." width="44%">
  &nbsp;&nbsp;&nbsp;
  <img src="docs/screenshots/mobile-editor.png" alt="The editor on mobile: an entry with rendered KaTeX math formulas and the floating formatting toolbar." width="44%">
</p>

---

## Quick start

On any Linux box with Docker — home server, NAS, that Raspberry Pi in the closet:

```bash
curl -fsSL https://raw.githubusercontent.com/mneme-blog/mneme/main/deploy/install.sh | bash
```

That's the entire installation. It checks the machine, generates its own secrets, pulls the images,
and starts the full production stack — Caddy with HTTPS, the Go relay, Postgres, MinIO, and a
speech-to-text server — then waits until Mneme genuinely answers before printing your URL and admin
token. It's safe to re-run: that updates the deployment and touches neither your config nor your
data.

Piping the internet into a shell should make you twitch, especially for something holding your
journal. [`deploy/install.sh`](./deploy/install.sh) is one readable file of plain bash — read it
first, then `bash install.sh`. Flags, the manual path, and day-two operations live in
[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md).

**Only kicking the tyres?** The dev stack needs Node 22+ and pnpm (`corepack` handles it):

```bash
corepack enable && pnpm install
pnpm dev                 # the app on http://localhost:5173
docker compose up -d     # optional: Postgres + MinIO + relay on :8080, if you want sync
```

Published ports, `_dev` passwords, plain HTTP — lovely for a look, spiritually a cardboard box.
Don't keep your real diary in it.

Either way, "Start a new journal" hands you twelve words. Which brings us to the important part.

---

> [!WARNING]
> ## There is no password reset. There is no admin recovery.
>
> Your account **is** a 12-word recovery phrase. No email, no password, no "forgot password" link —
> because there is no server-side secret that *could* unlock your data.
>
> **Lose the 12 words and your journal is gone. Permanently. Cryptographically. Forever.** Not "gone,
> call support." Whoever runs the server holds only unreadable blobs and cannot help you. This isn't
> an oversight; it's the literal mechanism that stops anyone else reading your diary, working exactly
> as intended.
>
> **Write the phrase down. On paper.** (A password manager works too.) Treat it like the key to a
> safe-deposit box holding your entire inner life, because that is precisely what it is.

---

## What makes it worth the twelve words

- **E2EE that actually means it.** Every entry and media chunk is sealed with XChaCha20-Poly1305 on
  your device. The relay compares one integer to resolve conflicts and understands nothing else.
- **An AI that writes *with* you, privately.** Guided interviews (written or on camera), Ask-my-journal
  over your own entries, and editor writing help — pointed at a local model like Gemma via
  [Ollama](https://ollama.com/) by default, never routed through the Mneme server, and **off until you
  turn it on**.
- **A real editor.** TipTap with a `/` palette, tables, checklists, syntax-highlighted code, KaTeX
  math, and `[[wikilinks]]` with backlinks.
- **Media that stays yours.** Photos and galleries, video and audio recording, file attachments,
  frozen travel maps, and on-device video-interview films — all chunk-encrypted before upload.
  Recordings can be transcribed by the speech-to-text server the stack ships with.
- **Local-first, offline-happy.** The real database lives on your device; the cloud is a courier.
  Lose the network and keep writing.
- **Yours to run.** One command, an operator dashboard, rolling encrypted backups, one-click updates
  with rollback — and AGPL, so a hosted fork stays open.
- **Made to live in.** Twelve UI languages (Arabic in full RTL), six theme skins × six accents,
  light/dark/system, installable as a PWA.

The exhaustive list is [`docs/FEATURES.md`](./docs/FEATURES.md); what's *not* built yet is
[`docs/ROADMAP.md`](./docs/ROADMAP.md), stated without flattery.

---

## How it works, briefly

```
your device                          the relay (out of trust)
┌───────────────────────────┐        ┌───────────────────────┐
│ 12 words → keys           │        │ Go binary + Postgres  │
│ local SQLite = the truth  │──ct──▶ │ opaque ciphertext,    │
│ TipTap · crypto · sync    │◀──ct───│ MinIO media chunks    │
└───────────────────────────┘        └───────────────────────┘
```

- **The phrase is the key tree.** BIP39 → HKDF-SHA256 → separate keys for entries, media, identity,
  and AI settings. Your `owner_id` is derived from it, so there's no signup and nothing on the server
  worth stealing.
- **Every ciphertext is `[version][nonce:24][ct+tag]`**, bound to the record it belongs to, so the
  relay can't serve one entry's body under another's id.
- **Three layers, one web codebase:** a Preact/TypeScript client (crypto, sync, editor, local DB), a
  Go relay that stores blobs and never decrypts, and Tauri shells to come.
- **Honest about metadata.** E2EE protects content, not shape: the relay sees roughly how often and
  how much you write. We list every accepted leak rather than pretending.
- **At rest,** nothing is persisted by default — you re-enter the phrase on a cold start. Optionally,
  seal the seed to the device under an Argon2id passphrase or a FIDO2 security key, with a 15-minute
  auto-lock.

It's pre-1.0 and there has been **no external security audit** — treat the guarantees as careful
design intent, not certification.

---

## Documentation

| Doc | What's in it |
|---|---|
| [`docs/FEATURES.md`](./docs/FEATURES.md) | Everything Mneme can do today. |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | Built, planned, and deliberately-not-building. |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Components, key derivation, sync, data model — with diagrams. |
| [`docs/ENCRYPTION.md`](./docs/ENCRYPTION.md) | Primitives, key hierarchy, envelopes, at-rest seals, rotation. |
| [`docs/SECURITY.md`](./docs/SECURITY.md) | Threat model, attack vectors, and known weaknesses. It does not flatter the project. |
| [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) · [`docs/MAINTENANCE.md`](./docs/MAINTENANCE.md) | Self-hosting, and day-two ops: backups, restore, upgrades. |
| [`docs/API.md`](./docs/API.md) · [`server/README.md`](./server/README.md) | The relay's HTTP surface, and running it. |
| [`docs/PWA.md`](./docs/PWA.md) · [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) | Installing it as an app; dev setup and quality gates. |
| [`SECURITY-AUDITS.md`](./SECURITY-AUDITS.md) · [`CLAUDE.md`](./CLAUDE.md) | The internal audit record, and the binding decision document. |

---

## License

[**AGPL-3.0-or-later**](./LICENSE) — use it, self-host it, fork it, but anyone running a modified
Mneme as a service must offer that source to its users.

*Named after the Greek muse of memory, who, fittingly, did not offer a password reset either.*
