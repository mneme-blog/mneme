# Code-quality findings — 2026-08-09 review

> **Status (2026-08-09, same branch):** All packages A–F are implemented, in the commit sequence
> `832b356` (A) → `1bdb8e5` (B) → `2f28f35` (C) → `2aab0ab` (D) → `7e2a541` (E) → F in ten commits
> ending at `ac75657`. Three consciously partial items, each documented at the site:
> **F2** — the separable logic was extracted (`state/helpers.ts`, memoized context value, flush
> reentrancy, status race) but the full 5-file provider split was deferred: the remaining core is
> interdependent sync machinery with no provider-level harness, and splitting it blind risks the
> exact regressions this exercise exists to prevent. **F5** — VideoCapture/AudioCapture share
> `ui/useMediaRecorder.ts`; VideoInterview's multi-take recorder stays separate by design
> (one stream across takes, per CLAUDE.md). **F10** — took the named "80% option" (C1+C2:
> typecheck over scripts + CI-enforced `check` runner, now 19 scripts) instead of a vitest
> migration. New regression scripts added along the way: `record-codec` (wire-codec field
> mapping, written *before* the F1 refactor as its safety net), `state-helpers`, `phrase-quiz`.

Full-tree code-quality review ahead of an external audit. Five parallel review passes covered
`apps/client/src/{state,sync,db,crypto}`, the UI layer (`ui/`, `screens/`, `editor/`, `hooks/`,
`styles/`), the feature modules (`ai/`, `video/`, `import/`, `location/`, `i18n/`, `search/`,
`platform/`, `data/`), the Go server (~8.7k lines), and the verification/meta layer
(`apps/client/scripts/`, `.github/`, `deploy/`, docs). All 16 locally runnable repro scripts were
executed and pass; `gofmt -l`, `go vet`, and the Go unit tests are clean.

This file is the **work list**. Each finding has an ID, severity, exact location, the problem, a fix
sketch, and how to verify. Findings are grouped into packages ordered by priority. Line numbers are
as of commit `339c759` — re-locate by the quoted code, not the number, if the file has moved.

## Rules for whoever fixes these

- **Do not reopen documented design decisions.** CLAUDE.md §1–§12 wins: LWW/no-CRDT, cleartext
  `entry_id`/`lww_clock`, accepted metadata leaks, forward-only migrations, pristine/builtin
  seeding, the AAD decrypt fallback, line-prefixed plan parsing, the integer film clock, and the
  *existence* of three Markdown parsers are all deliberate. Only the specific defects listed here
  are findings.
- **Behavior-preserving unless the finding says otherwise.** Packages A–E are targeted fixes;
  package F is refactoring that must not change observable behavior.
- **Verify after every package** (from repo root unless noted):
  - `pnpm --filter client typecheck && pnpm --filter client build`
  - `cd server && gofmt -l . && go vet ./... && go test ./...`
  - The dependency-free repro scripts:
    `for s in link-safety record-binding interview-title ollama-url markdown-roundtrip badges-repro math-click-repro markdown-editor-smoke labbook-repro location-repro seedlock-methods transcribe-repro video-interview-repro dayone-import dayone-import-persist i18n-dump; do pnpm --filter client exec tsx scripts/$s.ts || exit 1; done`
  - Relay-dependent checks (`scripts/integration.ts`, `templates-roundtrip`,
    `interview-types-roundtrip`, `journal-sync-roundtrip`, `ai-roundtrip`) need
    `docker compose up -d` first; the Go e2e suite needs
    `TEST_DATABASE_URL=... go test -tags e2e ./e2e/...` — **see B10 before running it against a dev DB**.
- Update CLAUDE.md §0 and `docs/` where a fix changes something they describe.
- Commit per package (or per finding for package A) with the finding IDs in the message.

Deletable/consolidatable volume identified: **~2,000–2,500 lines** total (~600–700 client core,
~1,100–1,300 UI, ~250–370 feature modules, ~150–220 server, ~175 scripts).

---

## Package A — Bugs (fix first; each is user-visible or security-relevant)

### A1 [High] `ollamaScope` misclassifies remote DNS names as "private" — the privacy badge can lie
`apps/client/src/ai/ollamaUrl.ts:52-53`. The IPv6 unique-local check `/^f[cd]/.test(host)` runs
against *any hostname* (not just IPv6 literals), and `PRIVATE_V4` matches any name starting with a
digit-dot pattern. Verified live: `http://fdroid.example.com:11434`, `https://fcstorage.io`, and
`http://10.example.net` all classify as `private` — journal plaintext going to an arbitrary
internet host gets the softer "another machine on the local network" copy. This module's header
says the label must not be able to lie.
**Fix:** require `host.includes(':')` before the `f[cd]`/`fe80:` checks; require a full dotted-quad
match (`/^\d{1,3}(\.\d{1,3}){3}$/`) before applying `PRIVATE_V4`. `transcriptionLocal` (loopback
only) is unaffected.
**Verify:** extend `scripts/ollama-url.ts` with the three cases above (expect `remote`) plus
`http://[fd12::1]:11434` and `http://10.0.0.5` (expect `private`); run it.

### A2 [High] Server backup/restore drops `owners.status` and `owner_sign_pubkey`
`server/internal/store/backup.go:22-26` (`OwnerRow`), `:89-98` (SELECT), `:199-205` (restore
INSERT). The row type predates migrations 0003/0004. After any restore: every owner becomes
`status='approved'` via the column default (a **rejected** vault is resurrected), and
`owner_sign_pubkey` becomes NULL (erasing the issue-#40 device-binding pin; all owners fall back
into pre-0004 grandfathering). `approval_hint` is dropped too. No test asserts these columns.
**Fix:** add `Status`, `ApprovalHint`, `OwnerSignPubkey` to `OwnerRow`; extend the SELECT and the
restore INSERT. Handle old archives (missing fields → defaults) explicitly — either bump the
archive `Format` or treat absent fields as `approved`/empty/NULL and say so in a comment.
**Verify:** add assertions to `internal/backup/backup_test.go` and `e2e/backup_e2e_test.go` that a
rejected owner stays rejected and the sign key survives a dump→restore round-trip.

### A3 [High] Client `pull()` ignores `PullResult.more` — bootstrap presents a partial vault as synced
`apps/client/src/state/data.tsx:588-700`. The relay caps a pull at 500 records; `sync/rotate.ts:96-107`
loops on `more`, the provider's `pull` does not. A second device restoring a 5,000-record vault
hydrates at 500 records per 30 s background tick (~5 min) while `bootstrapping` clears after the
first partial page (`:850-856`).
**Fix:** loop `while (res.more)` advancing the cursor inside `pull()` (mirror rotate.ts).
**Verify:** relay running → `scripts/journal-sync-roundtrip.ts` still passes; ideally extend a
roundtrip script to push >500 records and assert a single `pull` drains them.

### A4 [High] Calendar defines components inside the render — full subtree remount on every state change
`apps/client/src/screens/Calendar.tsx:218` (`Grid`), `:237` (`Nav`), `:268` (`Tabs`), `:276`
(`YearOverview`) are declared inside `CalendarScreen` and used as JSX element types. Preact treats
a new function identity as a different component: every `setSelected` destroys and recreates every
day cell, and the decade popover (state inside `Nav`) snaps shut on any Calendar state change.
**Fix:** hoist all four to module scope, passing what they close over as props (the file's own
`MiniMonth`/`Stat`/`ViewTab` already follow this pattern).
**Verify:** typecheck; manually: open the year-jump popover, click a day — popover must stay open.

### A5 [High] Hardcoded fake vault identity shown to users
`apps/client/src/screens/Journals.tsx:259` — `AccountChip` renders the literal `7f3a · velvet
harbor` in the mobile Journals header: prototype residue, untranslated, a fabricated identity in a
security-sensitive spot.
**Fix:** wire it to the real identity (`ownerId` prefix and/or the `crypto/hintwords.ts` hint the
pending-approval screen already uses) — or delete the chip.
**Verify:** grep for `velvet` returns nothing; mobile Journals header shows real identity.

### A6 [Medium] Film-render cancel races — a render can survive vault lock
Two halves:
(a) `apps/client/src/video/film.ts:243-256` — `cancelFn` is a no-op until the dynamic
`import('./fallback')` resolves; `stopAllRenders()` (vault lock/deletion, `:125-128`) in that
window cancels nothing and the realtime render then plays **decrypted clips** into a canvas after
the vault is "locked". Add a `canceled` latch checked after the import resolves (reject with the
render-canceled error before calling `mod.renderRealtime`).
(b) `apps/client/src/video/fallback.ts:161-184` — cancel stops the draw loop but the promise only
settles on `onended`; wire cancel to `el.pause()` + settle (or poll the flag in the draw loop).
**Verify:** `scripts/video-interview-repro.ts` passes; manual: start a fallback render, lock the
vault, confirm the render stops (no canvas/audio activity).

### A7 [Medium] Destroyed TipTap instance left in `EditorScreen` state
`apps/client/src/screens/Editor.tsx:422-425` — `useEffect([editor])` calls `onEditorReady(editor)`
with no cleanup; when the last `EntryEditor` unmounts (e.g. entry deleted → empty state) the parent
keeps a destroyed instance and the still-rendered toolbar dispatches into it.
**Fix:** return `() => onEditorReady(null)` from the effect.

### A8 [Medium] `useMediaUrl` renders a revoked object URL when the attachment id changes
`apps/client/src/ui/Attachments.tsx:60-81` — cleanup revokes the old URL but `url` state is not
reset, so `<img>/<video>` renders a revoked URL (broken frame) until the new resolve lands.
**Fix:** `setUrl(null)` at effect start. Also document (one comment) that `resolve` is deliberately
omitted from deps and must stay closure-stable.

---

## Package B — Error handling & robustness (small fixes, high audit value)

### B1 [High] Client `flush`/`pull` swallow every error as "offline"
`apps/client/src/state/data.tsx:580-581`, `:697-698` — bare `catch { setStatusLive('offline') }`.
A programming error or a permanent 4xx is rendered as connectivity and silently retried every 5 s.
**Fix:** log the error (`console.error`); distinguish `RelayError`/network `TypeError` (→ offline)
from everything else (→ log loudly, surface a sync-error state or at minimum stop conflating).

### B2 [High] Server 500 paths return errors without logging them
No `log.Printf` at: `internal/api/sync.go:96,137`, `auth.go:137,250,279,290,296`,
`reminders.go:14,58,71`, `admin.go:86,91,164`, `account.go:20` (contrast: `media.go:72`,
`backup.go:122,147`, `quota.go:34` do log).
**Fix:** fold logging into `writeError` for status ≥500 (`internal/api/respond.go:17`) — one place,
covers all sites; keep the client-facing message generic.

### B3 [Medium] Config parsing silently swallows invalid values; `envBool` defaults unknown → true
`server/internal/config/config.go:209-245`. `SESSION_TTL=24hours` or `QUOTA_BYTES_PER_OWNER=10GB`
silently fall back to defaults (a fat-fingered quota becomes *unlimited*); negatives are accepted
(negative `SESSION_TTL` mints expired sessions); `envBool` treats `"flase"` as **true**.
**Fix:** `log.Printf` a warning on any parse failure naming the variable and the fallback; clamp
negatives; make `envBool` accept only known true/false spellings and warn otherwise.
**Verify:** unit test the helpers with garbage input.

### B4 [Medium] `LocalDb.open` never settles if the worker fails to load
`apps/client/src/db/index.ts:257-264` — resolution only via `onmessage`; a CSP misconfig, partial
deploy, or OOM at worker start leaves `startSession` hanging (`data.tsx:791`) with `bootstrapping`
stuck, instead of triggering the designed in-memory degradation (`data.tsx:842-848`).
**Fix:** add `worker.onerror` (and `onmessageerror`) rejecting `open` and failing `#pending`
requests if the worker dies mid-session.

### B5 [Medium] `flush()` has no reentrancy guard
`apps/client/src/state/data.tsx:524` — invoked per editor change, per 30 s tick, per connect;
overlapping flushes re-push the same growing batch (a 100-entry import triggers ~100 overlapping
full-outbox pushes). `flushMedia` already has the `mediaFlushing` guard (`:487`).
**Fix:** same pattern — an in-flight flag; coalesce to one trailing re-run.

### B6 [Medium] Auth middleware conflates DB outage with invalid session
`server/internal/api/server.go:156-159` — any `LookupSession` error → 401 "invalid or expired
session"; during a Postgres blip every client is told its session is revoked. `handleVerify`
already distinguishes `ErrNotFound` (`auth.go:245-252`).
**Fix:** mirror it — `ErrNotFound` → 401, anything else → 503 (+ log via B2).

### B7 [Medium] Background workers have no shutdown join
`server/cmd/journald/main.go:132-135` — four naked goroutines; on SIGTERM the final usage flush
(`internal/api/metrics.go:147-160`, whose comment promises "a graceful shutdown loses nothing")
races process exit, and a scheduled backup mid-`.partial` is killed.
**Fix:** `sync.WaitGroup` (or errgroup) around the workers; wait after `srv.Shutdown` returns.

### B8 [Medium] `rotatePhrase` materializes every media blob into memory
`apps/client/src/state/data.tsx:1508-1511` calls `db.allMedia()` (all bytes) although
`sync/rotate.ts:55` deliberately takes a lazy `localMediaBytes(id)` callback. A vault with GBs of
video OOMs a mobile tab during rotation. Related: `startSession` loads all unsynced media bytes
into `pendingMedia` at unlock (`:839`).
**Fix:** pass `(id) => db.getMedia(id).then((m) => m?.data ?? null)`; keep only ids/metadata in
memory. For `pendingMedia`, queue ids and fetch bytes at upload time.

### B9 [Medium] Synchronous admin restore exceeds the server WriteTimeout
`server/internal/api/backup.go:110` (restore runs up to 30 min in-request) vs `WriteTimeout` 5 min
(`cmd/journald/main.go:168`) — a large restore succeeds server-side while the dashboard reports
failure.
**Fix:** detach like `handleAdminCreateBackup` already does (202 + poll, `backup.go:34-56`), or
document the limit and exempt the route.

### B10 [Medium] Go e2e suite truncates the entire database it is pointed at
`server/e2e/backup_e2e_test.go:43` restores an empty `RestoreData{}` — wiping whatever
`TEST_DATABASE_URL` names; the documented invocation points at the dev compose DB. Also
`TestApprovalFlow` leaks one owner row per run.
**Fix:** refuse to run unless the DB name contains `test` (or require an explicit
`E2E_ALLOW_WIPE=1`); add cleanup to `TestApprovalFlow` (pattern in `binding_e2e_test.go:55-59`).
Update the CLAUDE.md/docs invocation to a dedicated test database.

### B11 [Low] Assorted small robustness fixes
- `apps/client/src/main.tsx:39` — `initI18n()` rejection leaves a blank page; add `.catch` →
  render anyway (English fallback).
- `apps/client/src/state/data.tsx:886-890` — passphrase seal failure is silently swallowed
  (user asked to stay signed in, isn't, no error); surface it like the security-key path
  (`:863-867`).
- Fire-and-forget `void db.putLocal(...)` throughout data.tsx (e.g. `:1031,1047,1075,1117,1160`)
  — add a shared `.catch` that logs and flags a "local save failed" state instead of unhandled
  rejections.
- `apps/client/src/ai/ollama.ts:70`, `ai/anthropic.ts:75,81` — release stream readers on early
  return/throw (`finally { reader.cancel() }`).
- `apps/client/src/location/staticmap.ts:26-34` — add a timeout/`AbortSignal` to tile loads so
  `renderStaticMap` cannot hang the insert dialog forever.
- `apps/client/src/ui/AiSettings.tsx:465` — disable the Save button while `saving` (double-submit).
- `apps/client/src/ui/FilmRender.tsx:82-122` — guard `setStage`/`setError` after unmount in the
  imperative `start()` path (the effect path already has `alive`).
- `server/internal/api/quota.go:25` — `ctx` must be the first parameter.
- Reconnect loop (`data.tsx:1681-1683`) runs full register→challenge→verify every 5 s against the
  rate-limited endpoints; back off exponentially (e.g. 5 s → 60 s cap) after repeated failures.

---

## Package C — Enforcement & docs honesty (cheap, and the first thing an auditor checks)

### C1 [High] `scripts/` is not typechecked
`apps/client/tsconfig.json:30` — `"include": ["src", "vite.config.ts"]`. A rename in `src/`
silently breaks repro scripts. **Fix:** add `"scripts"` to `include`; fix whatever surfaces.

### C2 [High] Zero of the 24 client repro scripts run in CI
`.github/workflows/ci.yml:66-77` runs only `pnpm --filter client build`. Every "Regression check"
in CLAUDE.md (17 scripts, incl. security-critical `record-binding`, `seedlock-methods`,
`link-safety`, `ollama-url`) is convention only.
**Fix:** add a CI step running the 16 dependency-free scripts (list under "Rules" above); add a
`package.json` script (e.g. `pnpm --filter client check`) so contributors run the same thing.
Optionally gate the relay-dependent five behind a compose service like the server e2e job.

### C3 [Medium] `release.yml` publishes images and a GitHub Release with no test gate
`.github/workflows/release.yml:34ff` — no `needs`, no test steps; the one-click updater then offers
untested images to every install. **Fix:** run (or `needs`) the same server/client/updater jobs
before publishing.

### C4 [Medium] `dependabot.yml` is an invalid template stub — Dependabot never runs
`.github/dependabot.yml` still has `package-ecosystem: ""`. For a product whose crypto comes from
npm (`@noble/*`, `@scure/*`) nothing watches dependencies.
**Fix:** configure npm + gomod + github-actions ecosystems (weekly), or delete the file.

### C5 [Medium] CLAUDE.md claims lint tooling that does not exist
CLAUDE.md "Lint / format" + §11 assert eslint + prettier and golangci-lint; there is no config and
no lockfile entry for either; CI runs `gofmt` + `go vet` only.
**Fix:** either introduce the tooling or (cheaper, honest) reword to what is real: strict tsc
(`noUnusedLocals` etc.) for TS; gofmt + go vet for Go.

### C6 [Medium] CONTRIBUTING.md is stale in the opposite direction
`docs/CONTRIBUTING.md:60` says "no CI yet" (false — 4 jobs incl. Postgres e2e);
`:53-54`'s documented command `pnpm --filter client exec tsx apps/client/scripts/integration.ts`
fails as written (path double-prefixes; `exec` runs from `apps/client/`). **Fix:** correct both.

### C7 [Low] Misc doc drift
- CLAUDE.md i18n count "798/798" → real 821 (all locales full).
- CLAUDE.md §0 omits two shipped features: gamification badges (`state/badges.ts`,
  `ui/BadgeCelebration.tsx`, PR #78) and the WYSIWYG⇄Markdown source toggle (`editor/markdown.ts`).
- 5 scripts referenced nowhere in docs: `badges-repro`, `ollama-url`, `markdown-roundtrip`,
  `markdown-editor-smoke`, `math-click-repro` — name them where their features are described.
- CLAUDE.md §8 Dockerfile snippet says golang:1.23; real Dockerfile is 1.25. §4 tree shows
  `internal/auth/` which doesn't exist (auth lives in `internal/api/auth.go`).
- `apps/client/package.json:43` — `@types/node ^26` vs Node 22 everywhere; align to `^22`.
- Stale comments: `crypto/keys.ts:20` ("media key not used yet" — it is),
  `server/internal/config/config.go:124` ("not-yet-wired media"), `import/run.ts:174-175`
  (references a context outside this repo), `install.sh:54` (claims to read an address it
  hardcodes), `app.tsx:264` ("once unlocked" — not implemented; see E-list ⌘K item).
- `scripts/i18n.en.json` is a committed generated artifact already drifted (821 vs 798) — either
  regenerate in CI or stop committing it.

---

## Package D — Dead code deletions (~250–370 lines; safe, do in one commit)

| ID | Location | What |
|---|---|---|
| D1 | `apps/client/src/platform/notify.ts` + `notify.web.ts` + `notify.tauri.ts` | 114-line notification seam with **zero call sites** (reminders UI is unbuilt). Delete until §10 step 6, or mark explicitly as placeholder in CLAUDE.md. |
| D2 | `apps/client/src/video/fallback.ts:114-116` | No-op reduce `(a, c) => a + (c.blob.size > 0 ? 0 : 0)` and dead `totalMs`; also fold the duplicate clip-0 probe (`:67` + `:132`) into the `Promise.all`. |
| D3 | `apps/client/src/import/dayone.ts:177-183` | `parseMomentUrl` exported, zero call sites — `import/markdown.ts:23-27` re-implements it verbatim as `refFromUrl`. Keep one, import it. |
| D4 | `apps/client/src/db/schema.ts:178` | `SCHEMA_VERSION` exported, unused. |
| D5 | `apps/client/src/db/protocol.ts:19` + `db/worker.ts:29` | `columns` collected and shipped on every query, never read. |
| D6 | `apps/client/src/data/sample.ts:57-61,188-194` | `MNEMONIC`, `ENTRY_DAYS` exported, unused. |
| D7 | `apps/client/src/data/templates.ts:150` | `BUILTIN_TEMPLATE_SLUGS` — claimed "for tests/tooling", nothing imports it. |
| D8 | `apps/client/src/ui/primitives.tsx:8-36` | `Placeholder` dead (no importer) — also drop its `shell.photo` key from all 13 catalogs. |
| D9 | `apps/client/src/hooks/useTheme.ts:19-26,41-47` | Dead `name`/`hint` fields on SKINS/PALETTES (UI renders `t('prefs.skin.*')`) — second source of truth that will drift. |
| D10 | `apps/client/src/app.tsx:329` | `const setFlow = (f) => setFlowRaw(f)` no-op alias. |
| D11 | `server/internal/blobs/` (`blobs.go:32,60,92`, `s3.go:57-60`) | `Store.Delete` + both impls dead in production (only `DeletePrefix` is called). |
| D12 | `server/internal/api/update_test.go:135` | Unreachable statement after `t.Fatalf`. |
| D13 | `apps/client/src/video/filmProtocol.ts:37` (+ producer `filmWorker.ts:113`) | `ProbedMessage.durations` never read by the main thread. |
| D14 | `apps/client/src/video/cards.ts:90` | `lines.slice(0, 4).slice(0, 3)` → `slice(0, 3)`. |
| D15 | `apps/client/src/search/core.ts:28,47` | Drop `export` from internal-only `makeSnippet`/`dateHaystack` (keep `normalize`). |
| D16 | `apps/client/src/ui/VideoCapture.tsx:14` | Remove the `fmtDuration` re-export; point `Attachments.tsx:16` and `AudioCapture.tsx:10` at `ui/recorder.ts` like the other callers. |
| D17 | Redundant tombstone filters | `data.tsx:1716` already exposes live-only `entries`; delete the re-filters at `Preferences.tsx:293`, `Search.tsx:83`, `Editor.tsx:195,199,214,842` — or document why they stay. (`templates`/`interviewTypes` DO carry tombstones; leave those filters.) |
| D18 | `apps/client/src/ui/VideoInterview.tsx:294-298` | `goTo` checks the same value three times in five lines; and `:151` double-revokes `reviewUrl` (cleanup + every setter) — pick one owner. |
| D19 | `apps/client/src/sync/engine.ts:388-397` | `pushAiSettings` returns a bool no caller reads, with semantics contradicting the sibling pushers' documented contract — return `void` or align the semantics. |

Note (server, keep but flag): `deploy/spool.go:59,65-66` unused vocabulary constants are documented
as docs — leave, they are part of the agent contract.

---

## Package E — i18n / theming / RTL correctness (targeted, user-visible)

| ID | Sev | Location | Problem / fix |
|---|---|---|---|
| E1 | High | `apps/client/src/ui/Preferences.tsx:193,213,222,233,242-247` | `RelayServerRow` is entirely hardcoded English (7 strings) in a 12-locale app — including "Save"/"Cancel" which already exist as `common.save`/`common.cancel`. Add catalog keys + translations for all 12 locales. |
| E2 | Med | `apps/client/src/ui/AiSettings.tsx:330` | Hardcoded `Model` label; the Ollama card uses `t('assistant.settings.model')` ten lines up. |
| E3 | Med | `AiSettings.tsx:257`, `VideoInterview.tsx:529` | Toggle knob animates with physical `left:` — slides the wrong way in RTL; use `insetInlineStart`. Same for `VideoCapture.tsx:153` REC badge (sibling `VideoInterview.tsx:591` does it right) and `Search.tsx:147,152,158` physical margins. |
| E4 | Med | `screens/Editor.tsx:891`, `screens/JournalEntries.tsx:86` | `#786f62` (the **dark**-theme `--ink-3` value) pasted as month-band color — off-palette in light/other skins. Use `var(--ink-3)`. |
| E5 | Med | `screens/Calendar.tsx:77,454` | Heatmap built from hardcoded terracotta `#B0563A` — wrong under the five non-default accents. Derive from `var(--accent)`. |
| E6 | Med | 6+ files (ConfirmDialog, Attachments, VideoCapture, VideoInterview, Editor menu, …) | Danger red `#E4573D` scattered as a literal — add a `--danger` token in `tokens.css` (light+dark per skin) and use it. |
| E7 | Low | `apps/client/src/search/core.ts:9,28-44` | Date search is English-only (`jun 9`) in a 12-language app; append `Intl`-derived month names for the active locale to the haystack. |
| E8 | Low | `apps/client/src/i18n/en.ts:4-5` | Cross-fragment key collisions are silent (spread last-wins). Add a uniqueness assertion in `scripts/i18n-dump.ts` (~5 lines). |
| E9 | Low | `app.tsx:265-274` | ⌘/Ctrl+K registered while locked; the reset effect only fires on transition *to* locked, so search pops open right after unlock. Gate the handler on unlocked state. |
| E10 | Low | `ui/IOSNotice.tsx:98` | Literal `✕` glyph where every other close affordance uses `<Icon name="x">`. |
| E11 | Low | `ui/FilmRender.tsx:110` | Untranslated literal `'film'` stored as media-name fallback. |

---

## Package F — Structural refactorings (largest payoff, do AFTER A–E, one PR each, behavior-preserving)

### F1 [High] One "synced record kind" descriptor (~500–600 lines removed; shrinks the change surface from ~7 files to ~2)
The template/interviewType/journal/aiSettings plumbing is structural copy-paste at four layers:
- `sync/engine.ts:217-397` — five `toPushX`/`pushX` pairs (~180 lines) differing only in the body
  projection; pull router `:422-492` is the mirror-image field-copy chain.
- `db/index.ts` — templates block (`:350-429`) and interview-types block (`:431-510`) are ~80 lines
  each, identical modulo identifiers; entries/journals are variants; plus four parallel
  `COLS/rowToX/params/UPSERT` blocks (`:14-183`). A generic `SyncedTable<T>` descriptor cuts ~250
  of 637 lines.
- `state/data.tsx` — `create/update/deleteTemplate` (`:1148-1206`) vs
  `create/update/deleteInterviewType` (`:1208-1265`) pairwise identical; builtin-supersede pass
  duplicated (`:601-613` vs `:617-627`); four ack-retire blocks (`:549-564`); five pending refs
  maintained in four places (`:448-455`, `:978-985`).
- `sync/rotate.ts:87-167` — five near-identical drain/merge/push loops.
**Approach:** a `RECORD_KINDS` table of `{kind, encode, decode, table mapping}` codecs consumed by
engine (both directions — encode/decode can no longer drift), db, data.tsx CRUD factory, and
rotate. Use `satisfies` on the body objects so adding a field to a record type without touching its
codec is a compile error (this turns CLAUDE.md's prose-only LWW-field-loss warning into a guard).
**Verify:** all roundtrip scripts (relay running): `templates-roundtrip`,
`interview-types-roundtrip`, `journal-sync-roundtrip`, `ai-roundtrip`, `integration`; plus
`record-binding` and `dayone-import-persist`.

### F2 [High] Decompose `state/data.tsx` (1,738 → ~300 lines of composition)
46 context members, 15 useState + 17 useRef, ~12 responsibilities; two-thirds is sync/session
machinery. Target split: `state/session.ts` (identity/seal/unlock/auto-lock/pending-approval),
`state/syncController.ts` (non-React class owning outboxes/flush/pull/connect/status; provider
subscribes), `state/records.ts` (F1's descriptor + CRUD factory), `state/mediaStore.ts`,
`state/vaultOps.ts` (rotate/deleteVault). While at it:
- Memoize (or split) the context `value` (`:1736`) — today every sync tick re-renders every
  `useAppData` consumer.
- Move DB writes/flushes **out of `setState` updaters** (`updateEntry`, `attachFilm`,
  `attachTranscript`, `updateTemplate/InterviewType`, `deleteEntry:1363-1373`,
  `deleteJournal:1396-1416` smuggle values out of updaters) — this currently depends on Preact's
  eager dispatch and breaks under React semantics; compute first, then set state.
- Fix `connect()` status race (`:705-731`): don't set `'online'` unconditionally after self-catching
  `flush`/`pull` — have them report success/failure.
- One-line assert in `LocalDb.open` (`db/index.ts:256`): throw if already open for a different
  ownerId.
- Move `relativeDay` (`data.tsx:355`) to i18n utils.
**Verify:** typecheck + full script suite + manual smoke (unlock, edit, sync, rotate, delete vault).

### F3 [High] Shared `<Sheet>`/`<ModalCard>` shell + z-index tokens (~350–450 lines)
Counted across `ui/` + `screens/`: 26× hand-typed backdrop, 25× inner-card `stopPropagation`, 20×
the desk/mobile borderRadius ternary, 19× the grab-handle, 24× the same boxShadow, 10× a local
`pStyle`. Also: mixed `position:absolute` vs `fixed` backdrops (`Templates.tsx:333-335` documents
why fixed is the safe one) and magic z-indices 35/40/41/60/65/66/70/80/90/95.
**Approach:** one `<Sheet desk title icon onClose>` + `<SheetBackdrop>` in `ui/primitives.tsx`,
adopt Preferences' mousedown-tracked dismissal (`Preferences.tsx:283-299`) for all; z-index scale
as CSS tokens. Migrate overlays incrementally (each is mechanical).

### F4 [Medium] `useStreamingChat` + panel shell for AskJournal/GuidedInterview (~150 lines)
`ui/AskJournal.tsx:51-95,128-143,171-181` vs `ui/GuidedInterview.tsx:145-174,326-339,442-453` —
same token-append reducer, abort handling, error ternary, byte-identical bubble styles, same shell.

### F5 [Medium] `useMediaRecorder` for the three capture surfaces (~120+ lines)
`ui/VideoCapture.tsx:40-122` vs `ui/AudioCapture.tsx:136-216` share ~70% verbatim;
`VideoInterview.tsx:242-305` is a third implementation (deliberately holds its own stream — the
hook should take the stream as input so all three fit).

### F6 [Medium] Consolidate the delete-confirmation idioms (~90 lines)
Merge `ConfirmDeleteDialog` (`ui/Attachments.tsx:105-149`) into `ConfirmDialog` (it is a structural
clone; `ConfirmDialog.tsx:1-2` admits it). Extract `<TypedConfirmForm word onConfirm>` from
`DeleteVault.tsx:70-97` + `DeleteJournal.tsx:53-77`. Long-term: two idioms total (typed for
catastrophic, modal for the rest).

### F7 [Medium] ManagerSheet scaffold for Templates/InterviewTypes (~90 lines)
`InterviewTypes.tsx:5` admits "Mirrors ui/Templates.tsx structurally": duplicated `handle` helper,
`BuiltinChip`, `UI_13`, dashed new-button, `'list'|'new'|Record` state machine, armed two-tap
delete, header. Extract the scaffold; keep per-kind bodies.

### F8 [Medium] `PhraseReveal`/`PhraseQuiz` shared between Onboarding and RotatePhrase (~100–120 lines)
`screens/Onboarding.tsx:239-270,292-320` vs `ui/RotatePhrase.tsx:80-99,110-128` — same blur-grid +
reveal + copy + 3-word decoy quiz, two hand-maintained decoy arrays (`Onboarding.tsx:85`,
`RotatePhrase.tsx:36-38`). Also move `ManagerCredential`/`PassField` out of `screens/Onboarding.tsx`
into `ui/` (RotatePhrase and DeviceUnlock import from a screen today — layering inversion).

### F9 [Small] Assorted deduplication (~250 lines total)
- `aiErrorMessage(err, ctx)` helper — the hint→message ternary ladder appears 5× (`Attachments.tsx:203-214`,
  `AiSettings.tsx:166-172,183-194`, `AskJournal.tsx:79-87`, `GuidedInterview.tsx:131-141`,
  `AiActionDialog.tsx:59-67`).
- `<ScopeBadge>` — `ProviderBadge.tsx:9-14` documents that inline privacy-pill copies caused a stale
  disclosure; `AiSettings.tsx:264-266,311,348-351` has reintroduced four fresh inline copies.
- Month-separated entry-list row — three copies (`Editor.tsx:878-910`, `Calendar.tsx:481-523`,
  `JournalEntries.tsx:75-107`), with `listDate`/`monthKey` duplicated **including comments**.
- `app.tsx:461-484` vs `:489-524` — 16 sheets rendered twice (desktop/mobile); build the list once.
- Journal create/edit colour+cover pickers (`Journals.tsx:50-75` vs `:184-209`); cover-pattern CSS
  map exists 3× and is already drifting (`primitives.tsx:295-302`, `Journals.tsx:448-461`).
- `editor/doc.ts` `markdownToDoc` (~90 lines) is a strict subset of `editor/markdown.ts`'s parser
  **and shares its name with different behavior** — delegate and delete.
- `canonicalSize`/`even` duplicated (`video/filmWorker.ts:69-82` vs `fallback.ts:48,68-73`) — move
  the pure math to `video/timeline.ts`.
- AI context flattening triplicated (`ai/context.ts:34-58`, `ai/interview.ts:19-48`,
  `prompts.ts:24-28`, 4th `pad` in `search/core.ts:25`) — one `ai/flatten.ts`.
- Watch-with-replay registry duplicated (`video/film.ts:86-118` vs `ai/transcribeRuns.ts:20-47`) —
  one generic `registry<T>()`.
- Server: 3× GitHub GET boilerplate (`internal/api/version.go:157-195,232-263,319-341`),
  4× typed-confirm pattern → `requireConfirm(w, r, word)` (`admin.go:198-207`, `backup.go:97-107`,
  `update.go:77-91,111-124`); split `semver.go` out of the 448-line `version.go`.

### F10 [Optional] Scripts → vitest, or the 80% option
Full migration would delete ~175 lines of 5×-duplicated jsdom bootstrap
(`labbook-repro.ts:6-42`, `location-repro.ts:7-43`, `markdown-editor-smoke.ts:8-44`,
`math-click-repro.ts:4-40`, `video-interview-repro.ts:8-47`) and unify 4 assertion idioms — but
C1+C2 (typecheck + CI wiring) capture most of the value for a fraction of the diff. If staying on
tsx scripts: extract `scripts/lib/jsdom-env.ts` and `scripts/lib/assert.ts`.

---

## Explicitly NOT findings (documented decisions — do not "fix")
LWW tie-breaking and no CRDT; cleartext `entry_id`/`lww_clock`; rollback/withhold acceptance
(SECURITY.md §6.7); tombstone retention in raw lists; the AAD decrypt fallback + v9 re-push;
forward-only migrations (both sides); pristine/builtin seeding + supersede machinery; reminders'
cleartext `fire_at`; line-prefixed interview plan parsing; the integer clock and main-thread card
rasterization in film rendering; three Markdown parsers *existing* (only the F9 subset-delegation
and name collision are findings); mediabunny's PWA-precache cost; `deploy/spool.go` vocabulary
constants; Lightbox physical arrows in RTL.

## Server findings noted but low priority
Timing side channel in the auth challenge decoy (`auth.go:199-211` — a known device does an INSERT,
an unknown one doesn't; note it or add a dummy write). Reminders marked dispatched before dispatch
succeeds (`reminders/scheduler.go:59-70` — irrelevant for LogDispatcher, will bite at §10 step 6).
`updateChecker.info` holds the mutex across up to ~15 s of GitHub fetches (`version.go:132-154`).
`statusWriter` doesn't forward `Flusher`/`ReaderFrom` (`server.go:205-213`). CORS `Vary: Origin`
only on allowed origins (`cors.go:33-41`). Dashboard is a single 943-line embedded file — the CSP
test pins "exactly one inline script", which forbids splitting it; either accept as a documented
ceiling or serve `/admin/app.js` under `script-src 'self'`. `handlePush` does up to 500 sequential
round-trips (consider `pgx.Batch`); `store.Restore` inserts row-by-row (consider `CopyFrom`).
`internal/store` and `internal/reminders` have no unit tests (SQL only covered by opt-in e2e).
`take_backup` in `deploy/updater/mneme-updater.sh:291` scrapes human-oriented CLI output — a
`--porcelain` mode on `journald backup`/`list-backups` would decouple it.
