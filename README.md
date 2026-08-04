# Mneme

> A private place to remember — an open-source, local-first, **end-to-end-encrypted** journal.
> Your thoughts are encrypted on your device before they go anywhere. Nobody else can read them:
> not the server, not whoever runs the server, not a well-funded company that would dearly love to
> know what you think about. Including, if you lose your recovery phrase, **you**. More on that
> delightful little footgun in a moment — it's important, so we put it in a big yellow box.

Mneme is a calm, paper-coloured notebook for your thoughts. It runs in your browser today (native
desktop and mobile shells are on the way), keeps the real database on your own device, and syncs
through a server so clueless it couldn't spy on you if it tried.

And when the blank page wins — as it does for most people, most of the time — Mneme sits you down for
a **structured interview** instead. A **local AI model** (running on your own machine, so nothing
leaves it) asks you one reflective question at a time and then drafts a full entry from your answers
for you to keep or edit. It's the antidote to writer's block and blank-page anxiety, and the quiet
engine behind actually building a writing habit: you never have to face an empty box or wonder where
to start. The prompts are yours to shape, and it remembers past entries of the same kind so a
recurring reflection stays continuous.

---

## What it looks like

A warm, paper-coloured place to think — on a big screen and in your pocket. (Six theme skins and
dark mode included; this is the default "Paper" look.)

**The editor.** A zen writing surface with a quiet toolbar and a `/` command palette — headings,
checklists, tables, code, KaTeX math, galleries, and cross-entry links, every bit of it encrypted
before it leaves the device:

![The Mneme editor on desktop: a three-pane layout with notebooks, an entry list, and a serif writing surface showing rich text, inline math, and lists.](docs/screenshots/desktop-editor.png)

**The calendar.** A month grid with your entries in place, a day view beside it, and a writing
heatmap for the season:

![The calendar on desktop: a June month grid with entries on their days, a selected day showing its entry, and a writing heatmap.](docs/screenshots/desktop-calendar.png)

**And on your phone.** The same app, responsive down to a mobile shell with bottom navigation —
installable as a PWA today, native shells on the way:

<p align="center">
  <img src="docs/screenshots/mobile-journal.png" alt="A notebook on mobile: the Tutorial journal's entry timeline with previews and dates." width="44%">
  &nbsp;&nbsp;&nbsp;
  <img src="docs/screenshots/mobile-editor.png" alt="The editor on mobile: an entry with rendered KaTeX math formulas and the floating formatting toolbar." width="44%">
</p>

---

## Why this exists

Your journal is the most honest thing you own. It's where the unfiltered version of you lives — the
fears, the half-formed ideas, the things you'd never say out loud. That is *exactly* the data that
multi-billion-euro companies would most like to have, because nothing sharpens an advertising or
behavioural profile like a person's inner monologue.

Mneme is a small act of refusal. The premise is **data autonomy**: your private thoughts should be
yours alone, not raw material for someone else's profit model. So the design starts from a hard
rule — *the server can never read your journal* — and everything else follows from it. No accounts
to harvest, no plaintext on anyone's disk but yours, no telemetry, no "we value your privacy" page
that quietly means the opposite. You can run the whole thing on a Raspberry Pi in your closet and
owe no one an explanation.

The name comes from **Mneme**, the Greek muse of memory (one of the three original Boeotian muses,
if you want to win a pub quiz). Fittingly, she did not offer a password reset either.

---

> [!WARNING]
> ## There is no password reset. There is no admin recovery. Lose the phrase, lose the journal.
>
> Your account **is** a 12-word recovery phrase. There is no email, no password, no "forgot
> password" link — because there is no server-side secret that *could* unlock your data. Your phrase
> derives the only keys that can decrypt your journal, and those keys never leave your device.
>
> **If you lose your 12 words, your journal is gone. Permanently. Cryptographically. Forever.**
> Not "gone, call support." The person running the server *cannot* help you — they hold only
> unreadable encrypted blobs. This is not a bug or an oversight. It is the literal mechanism that
> stops anyone else from reading your diary, working exactly as intended.
>
> **Write the phrase down. On paper. Put it somewhere safe.** A password manager works too. Treat
> it like the key to a safe-deposit box that holds your entire inner life, because that is precisely
> what it is.

---

## What you can do with it

Mneme is a full journaling environment, not a text box. Everything below is **built and working
today** (in the browser app). This is the highlight reel; the exhaustive, up-to-date list lives in
[`docs/FEATURES.md`](./docs/FEATURES.md).

### Writing
- **A real rich-text editor** (TipTap/ProseMirror) with a Zen writing surface — serif body text, a
  quiet toolbar, and a `/` slash palette for inserting anything without reaching for the mouse.
- **Rich content**: headings, lists, checklists/tasks, blockquotes, **tables** (resizable), and
  **code blocks with syntax highlighting**.
- **Math typesetting** — write `$$x^2$$` inline or `$$$ ... $$$` for a display block; formulas render
  with KaTeX and open in a live-preview LaTeX editor when you click them.
- **Cross-entry links with backlinks** — type `[[` to link to another entry; each entry shows a
  "Linked from" list of everything that references it, so your journal becomes a little web of
  thought.
- **Editable date & time per entry** — backdate or re-date freely (and since the date rides *inside*
  the encrypted body, re-dating leaks nothing to the server).
- **Labels** with autocomplete, and **multiple notebooks** ("journals") to keep different threads
  apart.

### Media (all end-to-end encrypted, chunked, and synced)
- **Photos and image galleries** — drop images in, they group into galleries and open in a
  keyboard-navigable lightbox.
- **Video and audio recording** straight from the editor (via your camera/microphone).
- **File attachments** of any kind.
- **Location & travel maps** — pin a place or a from→to journey. The map is rendered **once** into a
  frozen image at insert time, so opening the entry later makes *no* further calls to any map
  service.

### Organising & finding
- **Vault-wide search** (⌘/Ctrl+K) across titles, bodies, labels, and dates.
- **A calendar** with month, year, and timeline views plus a writing heatmap.
- **Writing stats** — totals, streaks, and days journaled, all computed locally.
- **Templates** — built-in starters (experiment log, study notes, and more) plus your own, fully
  editable, synced as encrypted blobs.
- **Import** from existing journaling apps, rebuilt locally as encrypted entries (the import file
  never leaves your device).

### Make it yours
- **Six theme skins** (Paper, Modern, Terminal, Forest, Blossom, Lavender), each with a light and
  dark variant, times six accent tints. Light / dark / system, all stored locally and never synced.
- **Responsive** — a three-pane desktop layout above 920px, a mobile shell with bottom navigation
  below it.

### When things change
- **Recovery-phrase rotation** if you ever fear your phrase leaked (explained in detail below).
- **Entry, journal, and whole-vault deletion**, each behind an explicit confirmation, propagated to
  the server and any other device.

---

## The AI assistant (optional, off by default, and private by design)

Mneme has an AI assistant that can both **read** and **write** in your journal:

- **Ask my journal** — ask questions over your own entries and get answers grounded in what you've
  written.
- **Writing help** in the editor — Continue, Summarize, or Suggest-a-title for the entry you're on,
  always with a confirm-before-it-inserts step.
- **Guided interviews** — the assistant asks you one reflective question at a time, then drafts a
  full entry for you to review and save. It even remembers previous entries of the same kind, so a
  recurring "daily reflection" stays continuous. (There's also a one-line "freeform draft" mode.)
- **Transcribing recordings** — any video or audio in your journal can be turned into text, so what
  you said becomes searchable and readable by the assistant. The self-hosted stack ships its own
  speech-to-text server, so this needs no cloud account and no configuration; Preferences →
  Assistant → Transcription has a **Check server** button that says whether it is reachable and has
  its model ready — and offers to download the model if it doesn't. Before a recording is sent
  anywhere other than your own device, you get a confirmation naming exactly where it goes.

Here's the important part. The AI feature is **never** routed through the Mneme server — requests go
straight from your device to the model. You choose the model, and **the recommended choice is a
local or on-premise LLM** — something like **Gemma running under [Ollama](https://ollama.com/)** on
your own machine. With a local model, your most private thoughts are used to help you *and never
leave your computer*. That is the whole spirit of the project.

You **can** instead point it at a cloud model (bring your own Anthropic API key). It's more capable,
and it's there if you want it — but be clear-eyed about the trade: for each request, the entries
used as context are decrypted and sent over HTTPS to that provider. You would be handing your inner
thoughts to exactly the kind of large company this project exists to keep them away from. The choice
is yours; the settings screen states the consequence plainly, and the assistant ships **off by
default**.

(Your API key, if you use one, is itself sealed at rest under a key derived from your recovery
phrase — only openable while your vault is unlocked.)

---

## How the security works (the short version)

The one idea behind everything: **the server is outside your circle of trust.** It is a dumb relay
that stores encrypted blobs and shuffles them between your devices. It never sees plaintext, never
sees your keys, never sees your phrase.

- **End-to-end encryption.** Every entry and every media chunk is encrypted on your device with
  **XChaCha20-Poly1305** before it's sent. The server stores opaque ciphertext and can only compare
  a single integer to resolve which edit is newer.
- **The phrase is the account.** A 12-word BIP39 phrase derives all your keys and your `owner_id`.
  No signup, no email, no password database to breach — there's nothing on the server to steal that
  would help anyone read your journal.
- **Local-first.** The real database lives on *your* device (an encrypted-at-the-boundary, durable
  local store). The cloud is just a courier. Offline? Keep writing — it syncs when it can.
- **Honest about metadata.** E2EE protects *content*, not *shape*. The server can see roughly how
  often and how much you write, and your reminder times — never *what* you wrote. We don't pretend
  otherwise; the full list is in [`docs/SECURITY.md`](./docs/SECURITY.md).
- **At rest.** By default nothing is persisted but your entries (locally) — you re-enter the phrase
  on a cold start. Optionally ("stay signed in on this device"), your seed is sealed under an
  **Argon2id** passphrase, with a 15-minute inactivity auto-lock and a manual "Lock journal"
  control.

The deep, frank version — including the known weaknesses and accepted trade-offs — lives in
[`docs/SECURITY.md`](./docs/SECURITY.md). It does not flatter the project.

### Recovery-phrase rotation, explained properly

If you fear your 12 words may have leaked, you can **replace your recovery phrase** (Preferences →
Vault → "Replace recovery phrase"). This is *not* a password change — a phrase can't be edited in
place, because every key and your very identity are derived from it. Instead, rotation performs a
**full migration**:

1. A brand-new 12-word phrase is generated.
2. Your entire vault — every entry and every media object — is **re-encrypted under the new keys**.
3. It's pushed to the server as a **completely new owner**.
4. Only once everything is safely stored under the new identity is the **old account wiped**
   (`DELETE /v1/account`) and the old local database destroyed.

The old account stays fully intact until that final step, so an interrupted rotation never loses
data, and retrying with the same new phrase is safe. Afterwards, the **leaked phrase unlocks
nothing but an empty vault**.

> [!IMPORTANT]
> Rotation protects you *going forward*. It cannot retract copies an attacker may have already
> copied while the old phrase was valid. And of course: write the **new** phrase down too. The same
> warning as before applies in full.

---

## Quick start (kicking the tyres on your own machine)

> [!NOTE]
> This is the **dev** setup — the fastest way to see Mneme run. It uses published ports, `_dev`
> default passwords, and plain HTTP. It is emphatically **not** how you should host your actual
> journal. When you want a real, HTTPS, restart-on-crash, backed-up deployment, follow
> **[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)** instead. Running your real diary on the dev stack is
> like storing your valuables in the display safe from the hardware store: technically a safe, spiritually
> a cardboard box.

You'll need **Node 20+** and **pnpm 10** (the repo pins it; `corepack` handles it).

```bash
corepack enable      # wake up the package manager (once)
pnpm install         # install dependencies
pnpm dev             # run the app
```

Open **http://localhost:5173** and you're in. "Start a new journal" generates a real 12-word
recovery phrase (write it down!); "I have a recovery phrase" restores from one you already have (a
password manager can save and fill it).

That's enough to write — the app works fully offline against its local database. To sync between
devices, bring up the relay too:

```bash
docker compose up -d            # Postgres + MinIO + the relay, on :8080
curl localhost:8080/healthz     # {"status":"ok"}
```

The client points at `http://localhost:8080` by default (override with `VITE_RELAY_URL`). The vault
indicator switches to "synced · encrypted" once the handshake succeeds; if the relay is down, the
app simply stays local and shows "offline" — your writing is never blocked on the network.

Want to watch the whole crypto + sync round-trip without a browser? With the relay running:

```bash
pnpm --filter client exec tsx scripts/integration.ts   # register → auth → encrypt → push → pull → decrypt
```

---

## Running it for real (self-hosted)

Everything above is the **dev** stack — published ports, `_dev` passwords, plain HTTP — the fastest
way to *see* Mneme, and emphatically not how to *keep* your journal. For a real deployment the server
is a single featherweight Go binary (`journald`, a deliberately clueless relay for opaque encrypted
blobs) fronted by Caddy for HTTPS: a four-container stack (Caddy + relay + Postgres + MinIO) that
restarts on crash and rolls its own encrypted backups. Several hundred users of an E2EE journal is,
server-side, basically free — there's nothing to index or render.

- **[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)** — the full production runbook: the Docker + Caddy
  stack, HTTPS on a LAN, first start, the `.env.prod` secrets, and the optional operator admin
  dashboard.
- **[docs/MAINTENANCE.md](./docs/MAINTENANCE.md)** — day-two operations: backups, restore, upgrades,
  health checks, and troubleshooting.
- **[server/README.md](./server/README.md)** and **[docs/API.md](./docs/API.md)** — the relay's API
  surface and its own test suite.

The whole point survives the move to a server: an archive, a database dump, or a full MinIO bucket is
**useless without a user's 12-word recovery phrase**. You host encrypted blobs beautifully and still
can't read a word.

---

## Documentation

The README is the friendly tour. The neutral, detailed references live in [`docs/`](./docs) — start
with [`docs/README.md`](./docs/README.md):

| Doc | What's in it |
|---|---|
| [`docs/FEATURES.md`](./docs/FEATURES.md) | Everything Mneme can do today, in one place. |
| [`docs/ROADMAP.md`](./docs/ROADMAP.md) | Honest status board: built, planned, and deliberately-not-building. |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Components, key derivation, the sync sequence, the data model — with diagrams. |
| [`docs/ENCRYPTION.md`](./docs/ENCRYPTION.md) | The cryptography: primitives, key hierarchy, the ciphertext envelope, at-rest seals, rotation. |
| [`docs/SECURITY.md`](./docs/SECURITY.md) | The E2EE threat model and a frank list of attack vectors and known weaknesses. |
| [`docs/API.md`](./docs/API.md) | The relay's HTTP API reference, including the admin surface. |
| [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) | Self-hosted production deployment: the Docker + Caddy stack, HTTPS on a LAN, first start. |
| [`docs/MAINTENANCE.md`](./docs/MAINTENANCE.md) | Day-two operations: backups, restore, upgrades, health checks, troubleshooting. |
| [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) | Setup, the quality gates, conventions, and where things live. |
| [`server/README.md`](./server/README.md) | Running, configuring, and testing the Go relay specifically. |
| [`CLAUDE.md`](./CLAUDE.md) | The decision document and source of truth (§0 is the operating guide; §1–§12 the binding decisions). |

---

## Current state

It's pre-1.0 and we're honest about it. The four screens, the Go relay, and the encryption are
built, and the client is genuinely wired to the relay: real BIP39 onboarding, client-side
encryption, encrypted push/pull sync, a durable local database, a real editor, encrypted media, AI
assistant, templates, search, and phrase rotation all work end-to-end today, in the browser.

Still ahead: a full-text search index (blocked on a custom wa-sqlite build), a reminders UI + local
scheduled notifications, broader export, and the native **Tauri** desktop and mobile shells with
OS-keychain storage. There has been **no external security audit** — treat the guarantees as careful
design intent, not certification, and don't trust it with data you can't afford to lose until it's had
more eyes. The full status board is in [`docs/ROADMAP.md`](./docs/ROADMAP.md); the binding build order
is [`CLAUDE.md`](./CLAUDE.md) §10.

---

## License

[**GNU Affero General Public License v3.0 or later**](./LICENSE) (AGPL-3.0-or-later).

Mneme is a network-served application, and the AGPL is a deliberate choice: anyone who runs a
modified version of the relay as a hosted service must offer that modified source to its users. Use
it, self-host it, fork it — but improvements to a public deployment stay open. See [`LICENSE`](./LICENSE)
for the full text.

---

*Mneme — named after the Greek muse of memory, who, fittingly, did not offer a password reset
either.*
