# Features

Everything Mneme can do **today**, in one place. If it's listed here without a caveat, it's built and
working in the browser app right now — not a mockup, not a "coming soon," not a slide in a pitch deck.
Things that are genuinely not done yet live in [ROADMAP.md](./ROADMAP.md), clearly labelled, because
pretending otherwise would be exactly the kind of behaviour this project exists to avoid.

Everything below happens **on your device**. Entries, media, templates, and settings are encrypted
before they ever touch the network, and the server — bless its clueless little heart — only ever sees
opaque ciphertext. See [ENCRYPTION.md](./ENCRYPTION.md) if you'd like to watch how the sausage is
cryptographically made.

---

## Writing

A real editor, not a glorified `<textarea>`.

- **Rich-text editor** (TipTap / ProseMirror) with a calm Zen writing surface — serif body text, a
  quiet toolbar that stays out of your way, and a `/` slash palette so you can insert anything without
  the indignity of reaching for the mouse.
- **Structured content** — headings, bullet/numbered lists, **checklists / tasks**, blockquotes,
  **resizable tables**, and **code blocks with syntax highlighting** (auto-detected grammars, with a
  warm-paper light theme and a dark variant).
- **Math typesetting** — type `$$x^2$$` inline or `$$$ … $$$` for a display block; formulas render
  with KaTeX and reopen in a live-preview LaTeX editor when you click them. The LaTeX source is
  surfaced to search and previews, so your equations are findable, not just pretty.
- **Cross-entry links with backlinks** — type `[[` to link to another entry. Each entry grows a
  "Linked from" list of everything that references it, quietly turning your journal into a little web
  of thought. Renames heal themselves; deleted targets render as polite muted chips rather than
  breaking.
- **Editable date & time per entry** — backdate, re-date, time-travel freely. Because the date rides
  *inside* the encrypted body, moving it around leaks precisely nothing to the server.
- **Labels** with autocomplete, and **multiple notebooks** ("journals") to keep your dream diary and
  your tax anxieties in separate rooms.

## Media (all end-to-end encrypted, chunked, and synced)

- **Photos & image galleries** — drop images in; consecutive ones group into a gallery and open in a
  keyboard-navigable lightbox.
- **Video & audio recording** straight from the editor via your camera and microphone. No upload to
  anyone's "cloud studio," no terms of service granting a perpetual worldwide licence to your face.
- **File attachments** of any kind.
- **Transcription** of any video or audio in your journal — retroactive, per recording or per
  interview answer. Transcripts are content, not metadata: they live inside the encrypted entry body,
  they are editable by hand, they feed search and "Ask my journal", and they survive deleting the
  recording they came from. See the assistant section below for where the audio goes.
- **Location & travel maps** — pin a single place or a from→to journey, with an optional travel photo.
  The map is rendered **once** into a frozen image at insert time, so opening the entry later makes
  *zero* further calls to any map service. (The one, clearly-labelled, opt-in-per-insert exception is
  the address lookup at creation time — see
  [SECURITY.md](./SECURITY.md#location-snapshots--a-one-time-per-insert-exception).)

## Organising & finding

- **Vault-wide search** (⌘/Ctrl+K, plus a sidebar field, a mobile nav entry, and a bar on the journals
  screen) across titles, bodies, labels, and date spellings. Substring for now; a proper full-text
  index is [waiting on a wasm build](./ROADMAP.md) rather than on anyone's good intentions.
- **Calendar** with month, year, and timeline views, plus a writing **heatmap** so you can feel gently
  judged by your own consistency.
- **Writing stats** — totals, streaks, and days journaled, all computed locally over your decrypted
  entries. Nobody else is counting.
- **Templates** — built-in starters (Experiment log, Study notes, and friends) *and* your own, fully
  editable and deletable. They sync as encrypted blobs; the server can't tell a template from an entry,
  which is rather the point.

## The AI assistant (optional, off by default, private by design)

The assistant can both **read** and **write** in your journal — and it is **never** routed through the
Mneme server. Requests go straight from your device to a model of your choosing. The **recommended**
choice is a local model (e.g. Gemma via [Ollama](https://ollama.com/)), in which case your most
private thoughts help you *and never leave your computer*.

- **Ask my journal** — question-and-answer grounded in your own entries.
- **Editor writing help** — Continue, Summarize, or Suggest-a-title for the current entry, always with
  a confirm-before-it-inserts step.
- **Guided written interviews** — the assistant asks one reflective question at a time, then drafts a
  full entry for you to review and save (titled from the draft, labelled with the interview type).
  Starting one feeds it your recent entries of the same kind, so a recurring "evening reflection"
  stays continuous. There's also a one-line **freeform draft** mode.
- **Guided video interviews** — the same interview types, answered on camera. The whole question list
  is planned in one call up front and shown in an **editable plan step** (target six questions, eight
  max); the session then runs question by question with retake, skip, and back, a per-question
  countdown, and device-local capture quality (360p/720p/1080p). Recording itself makes **zero AI
  calls and zero network requests** — the model never hears an answer, which is exactly why the
  adaptivity happens before the session rather than during it, and why no audio is ever handed to a
  browser speech-recognition service. If the model is unreachable or returns junk, a **built-in
  question set** stands in, so a session never dead-ends.
- **One-click film rendering** — the answers stitch into a single video with each question cut in as
  a ~2.5 s title card, rendered **entirely on-device** (WebCodecs via mediabunny, with a realtime
  canvas fallback where WebCodecs is missing or video-only). Source clips are kept so an answer can
  be retaken and the film re-rendered; "Delete the source clips" reclaims the space when you're done.
- **Auto-transcribe answers** — optional, chosen in the plan step, with a spoken-language picker
  (asked for, never guessed from your UI language — Whisper treats language as a constraint, and told
  the wrong one it returns fluent nonsense). Answers can equally be transcribed later, from any
  device.
- **Transcription** — recordings are turned into text by a speech-to-text server speaking the
  OpenAI `/v1/audio/transcriptions` shape. **The self-hosted stack bundles one** (Speaches, proxied
  same-origin), so this needs no cloud account and no configuration; you can point it at your own
  loopback server instead. The bundled endpoint is not left open to whoever can reach the site —
  every transcription is authorized by the relay first, which sees only the session token and the
  declared size, never the audio — and per-vault daily allowances are the operator's to set. Before a
  recording leaves your device for anywhere but localhost, a dialog names the exact destination.
  Preferences → Assistant → Transcription has a **Check server** button and a one-click model
  download.
- **Interview types** — fifteen built-ins spanning daily journaling (Daily check-in, Morning
  intention, Evening reflection, Gratitude, Mood & energy, Weekly review), work (Work standup, 1:1
  prep, Project retro), and study/lab (Study recap, Lecture reflection, Exam prep, Experiment
  debrief, Research progress, Troubleshooting log) — plus your own. All editable and deletable, all
  synced like templates as encrypted blobs the server can't tell apart from entries.

You *can* point it at a cloud model instead (bring your own Anthropic API key). It's more capable, and
the trade-off is stated plainly on the settings screen: for each request, the context entries are
decrypted and sent over HTTPS to that provider. Your key is sealed at rest under a key derived from
your recovery phrase, and the AI settings sync to your other devices as an encrypted record. The
server still can't read or use the key. Full analysis in
[SECURITY.md](./SECURITY.md#the-opt-in-ai-assistant--a-deliberate-user-consented-exception).

## Import

- **Day One import** — feed it a Day One JSON export `.zip` and it rebuilds the whole thing locally as
  encrypted entries: journals become notebooks, media is re-encrypted and attached, original dates and
  tags are preserved. The zip never leaves your device. (Other formats and a proper export are on the
  [roadmap](./ROADMAP.md).)

## Make it yours

- **A dozen languages** — the whole UI is localized into English, German, Spanish, French, Italian,
  Dutch, Finnish, Arabic, Hindi, Japanese, Korean, and Chinese, with proper `Intl` date/number
  formatting and pluralization. Arabic flips the entire document to **RTL** (`<html dir="rtl">`, logical
  CSS throughout). Pick a language in Preferences → Appearance; like the theme, it's device-local and
  never synced.
- **Six theme skins** — Paper, Modern, Terminal, Forest, Blossom, Lavender — each with a full light and
  dark variant, times **six accent tints**. Light / dark / system. All stored device-locally and never
  synced, because your taste in colours is nobody's business but yours.
- **Responsive shell** — a three-pane desktop layout above 920px, a mobile layout with bottom
  navigation below it.

## Security & lifecycle (the load-bearing features)

- **Recovery-phrase login** — a 12-word BIP39 phrase *is* your account. No email, no password, no
  "create account" funnel harvesting your details.
- **Stay-signed-in, done properly** — opt in to seal your seed on the device under either an
  **Argon2id passphrase** or a **FIDO2 / WebAuthn security key** (YubiKey, platform passkey). Switch
  between passphrase ⇄ security key ⇄ off in Preferences → Vault. A **15-minute inactivity auto-lock**
  and a manual **Lock journal** control keep an unattended device honest.
- **Recovery-phrase rotation** — if you fear your phrase leaked, "Replace recovery phrase" re-encrypts
  your entire vault under a fresh phrase and new identity, then wipes the old one. The leaked phrase is
  left unlocking an empty vault. (Details in [SECURITY.md](./SECURITY.md).)
- **Deletion that actually deletes** — entry, journal, and whole-vault deletion, each behind an
  explicit (and for the scary ones, type-the-word) confirmation, propagated to the server and every
  other device.
- **Offline-first** — the real database lives on *your* device. Lose the network and you keep writing;
  it syncs when it can. The vault chip just shrugs and says "offline."
- **Installable** — served over HTTPS, Mneme installs to your home screen or dock as a Progressive Web
  App: its own window, offline-capable, no app store. ([How to install](./PWA.md).)

## For the operator (if you self-host the relay)

- **Admin dashboard** (`/admin`, disabled until you set `ADMIN_TOKEN`) — per-vault storage footprints
  (keyed by pseudonymous hashes, never names) and owner-less daily aggregate counters. It shows
  **health and growth, never people**, because the data to identify anyone simply isn't there.
- **Operator vault deletion** — wipe a vault by id, behind a typed `"delete"` confirmation.
- **New-vault approval** — because the mnemonic *is* the account (no signup), an open relay lets
  anyone store their own encrypted journals on it. Set `REQUIRE_APPROVAL=true` and a new vault lands
  **pending** and can't sync until you approve it in the dashboard — turning the relay single-tenant
  (or hand-picked) without a separate login gate. Each pending vault shows a memorable code
  (`amber-otter-07`) the user reads off their own "waiting for approval" screen, so you can tell which
  is which. Existing vaults are grandfathered, and reject cuts a vault off immediately.
- **Backups & disaster recovery** — one gzipped archive of every vault's ciphertext (no keys, no
  plaintext), via the dashboard *or* the `journald backup` / `restore` / `list-backups` CLI. See
  [MAINTENANCE.md](./MAINTENANCE.md).
- **Update awareness** — the dashboard checks the running build against the latest GitHub release
  (`/admin/version`) and quietly tells you when a newer one exists. Tagged releases (`v*`) build and
  publish a Docker image automatically via GitHub Actions.

---

For where each of these lives in the code and how they fit together, see
[ARCHITECTURE.md](./ARCHITECTURE.md). For what's *not* here yet, see [ROADMAP.md](./ROADMAP.md).
