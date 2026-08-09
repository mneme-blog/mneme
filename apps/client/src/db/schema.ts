// Forward-only schema for the local source-of-truth DB (CLAUDE.md §5a, §11).
//
// Everything here is plaintext: this DB lives only on the unlocked device, and
// the relay never sees it — only version-prefixed ciphertext blobs sync (§3, §5b).
// Migrations are append-only: never edit an existing entry, only push the next.
// The applied version is tracked in `PRAGMA user_version`.

export const MIGRATIONS: string[] = [
  // ── v1 — entries ──
  `
  CREATE TABLE entries (
    id          TEXT PRIMARY KEY,           -- random 128-bit hex, never date-encoded (§3)
    journal_id  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,           -- ms since epoch
    updated_at  INTEGER NOT NULL,           -- ms — also the LWW clock (§3)
    title       TEXT NOT NULL DEFAULT '',
    body_text   TEXT NOT NULL DEFAULT '',   -- flattened plaintext (previews + search)
    body_json   TEXT,                       -- TipTap/ProseMirror document JSON (rich source)
    labels      TEXT NOT NULL DEFAULT '[]', -- JSON array of label ids
    deleted     INTEGER NOT NULL DEFAULT 0,
    dirty       INTEGER NOT NULL DEFAULT 0  -- 1 → still waiting in the sync outbox
  );
  CREATE INDEX entries_journal ON entries(journal_id);
  CREATE INDEX entries_updated ON entries(updated_at);
  CREATE INDEX entries_dirty   ON entries(dirty) WHERE dirty = 1;
  `,
  // ── v2 — media attachments (§5a, §10 step 5) ──
  // entries.attachments mirrors the encrypted-body attachment list (JSON array of
  // MediaAttachment); the bytes themselves live in `media.data` as plaintext —
  // this DB exists only on the unlocked device (§5a). `synced` is the media
  // outbox flag: 0 → still waiting to be uploaded to the relay.
  `
  ALTER TABLE entries ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
  CREATE TABLE media (
    id          TEXT PRIMARY KEY,           -- random 128-bit hex, never date-encoded (§3)
    entry_id    TEXT NOT NULL,
    mime        TEXT NOT NULL,
    bytes       INTEGER NOT NULL,           -- plaintext size
    duration_ms INTEGER,
    created_at  INTEGER NOT NULL,           -- ms since epoch
    data        BLOB,                       -- NULL until downloaded from the relay
    synced      INTEGER NOT NULL DEFAULT 0  -- 0 → in the media upload outbox
  );
  CREATE INDEX media_entry    ON media(entry_id);
  CREATE INDEX media_unsynced ON media(synced) WHERE synced = 0;
  `,
  // ── v3 — entry templates (§5a, §10 step 7) ──
  // Templates sync as encrypted blobs through the entry oplog (the record kind
  // lives inside the ciphertext). `builtin` is the predefined-template slug
  // (NULL for user templates); `pristine` marks an untouched built-in seed —
  // pristine rows are local-only (never pushed) and get retired when an edited
  // or deleted copy of the same built-in arrives from another device.
  `
  CREATE TABLE templates (
    id          TEXT PRIMARY KEY,           -- random 128-bit hex, never date-encoded (§3)
    name        TEXT NOT NULL DEFAULT '',
    body_text   TEXT NOT NULL DEFAULT '',   -- flattened plaintext (previews)
    body_json   TEXT,                       -- TipTap/ProseMirror document JSON
    builtin     TEXT,                       -- built-in slug, NULL for user templates
    pristine    INTEGER NOT NULL DEFAULT 0, -- 1 → untouched built-in seed (local-only)
    created_at  INTEGER NOT NULL,           -- ms since epoch
    updated_at  INTEGER NOT NULL,           -- ms — also the LWW clock (§3)
    deleted     INTEGER NOT NULL DEFAULT 0,
    dirty       INTEGER NOT NULL DEFAULT 0  -- 1 → still waiting in the sync outbox
  );
  CREATE INDEX templates_dirty ON templates(dirty) WHERE dirty = 1;
  `,
  // ── v4 — media tombstones (relay-side deletion queue) ──
  // A confirmed media delete must also remove the ciphertext from the relay
  // (DELETE /v1/media/{id}). The id waits here until the relay acknowledges,
  // so deletions done offline survive reloads — same idea as the dirty flags.
  `
  CREATE TABLE media_tombstones (
    id          TEXT PRIMARY KEY,           -- media id awaiting relay-side deletion
    created_at  INTEGER NOT NULL            -- ms since epoch (when the user deleted it)
  );
  `,
  // ── v5 — journals (the local notebook grouping) ──
  // Journals are a per-device grouping only (§3 isolated tenants): they hold no
  // content and never sync — entries reference journal_id inside their encrypted
  // body. Deletion is a tombstone, not a DROP: the sample notebooks seed once
  // per device (row count 0 = never seeded), and a kept row is what stops a
  // deleted sample journal from re-seeding on the next unlock.
  `
  CREATE TABLE journals (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT '',
    subtitle    TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT '',
    cover       TEXT NOT NULL DEFAULT 'plain',
    created_at  INTEGER NOT NULL,           -- ms since epoch
    deleted     INTEGER NOT NULL DEFAULT 0
  );
  `,
  // ── v6 — guided-interview types (§10 step 7 sibling) ──
  // Interview types sync as encrypted blobs through the entry oplog exactly like
  // templates (the record kind lives inside the ciphertext). Same builtin/pristine
  // semantics; `prompt` is the question strategy the AI follows during an interview,
  // `intro` the one-line blurb shown in the picker.
  `
  CREATE TABLE interview_types (
    id          TEXT PRIMARY KEY,           -- random 128-bit hex, never date-encoded (§3)
    name        TEXT NOT NULL DEFAULT '',
    intro       TEXT NOT NULL DEFAULT '',   -- one-line picker description
    prompt      TEXT NOT NULL DEFAULT '',   -- the question strategy (system-prompt fragment)
    builtin     TEXT,                       -- built-in slug, NULL for user types
    pristine    INTEGER NOT NULL DEFAULT 0, -- 1 → untouched built-in seed (local-only)
    created_at  INTEGER NOT NULL,           -- ms since epoch
    updated_at  INTEGER NOT NULL,           -- ms — also the LWW clock (§3)
    deleted     INTEGER NOT NULL DEFAULT 0,
    dirty       INTEGER NOT NULL DEFAULT 0  -- 1 → still waiting in the sync outbox
  );
  CREATE INDEX interview_types_dirty ON interview_types(dirty) WHERE dirty = 1;
  `,
  // ── v7 — cached image thumbnails ──
  // A small downscaled JPEG of an image attachment, generated client-side from
  // the decrypted bytes the first time the entry lists need to show it. Lets the
  // overview lists render tiny previews instead of decoding the full-resolution
  // (multi-MB) image into the DOM. Plaintext like `data` (this DB is local-only,
  // §5a); NULL until generated, never synced.
  `
  ALTER TABLE media ADD COLUMN thumb BLOB;
  `,
  // ── v8 — journal sync bookkeeping ──
  // Journals now sync through the entry oplog as encrypted records (kind:
  // 'journal' inside the ciphertext). `record_id` is the journal's cleartext
  // oplog id — always random, NEVER the journal id: the sample notebooks have
  // well-known ids and user notebooks timestamp-encoded ones, either of which
  // would leak in the oplog (§3); the journal id rides inside the ciphertext.
  // Same pristine/dirty semantics as templates. Existing rows: untouched sample
  // seeds stay local-only (pristine); everything the user shaped — created,
  // renamed, restyled — is marked dirty so it pushes once and reaches the
  // user's other devices. Pre-sync tombstones stay local (pushing an old local
  // deletion could tombstone another device's identically-seeded notebook).
  `
  ALTER TABLE journals ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE journals ADD COLUMN pristine   INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE journals ADD COLUMN dirty      INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE journals ADD COLUMN record_id  TEXT;
  UPDATE journals SET updated_at = created_at;
  UPDATE journals SET pristine = 1 WHERE deleted = 0
    AND ((id = 'j-tutorial' AND name = 'Tutorial' AND subtitle = 'How Mneme works')
      OR (id = 'j-personal' AND name = 'My Journal' AND subtitle = 'Your first notebook'));
  UPDATE journals SET dirty = 1 WHERE deleted = 0 AND pristine = 0;
  CREATE INDEX journals_dirty ON journals(dirty) WHERE dirty = 1;
  `,
  // ── v9 — re-push every record once, so its ciphertext carries the id binding ──
  // Record bodies are now encrypted with the wire id as AAD (sync/engine.ts), so
  // the relay can no longer hand back one record's ciphertext under another
  // record's id. Blobs written before that change carry no binding and stay
  // relabellable for as long as they sit on the relay, and nothing would ever
  // rewrite them: a record is only re-pushed when it is edited.
  //
  // So mark everything dirty once. The outbox re-encrypts and re-pushes each
  // record on the next sync — same content, same clock, now bound — and LWW
  // makes that a no-op for every other device. Pristine seeds are left alone:
  // they are deliberately local-only until first edited, and pushing them here
  // would put built-in templates and sample notebooks on the relay for everyone.
  `
  UPDATE entries SET dirty = 1;
  UPDATE templates SET dirty = 1 WHERE pristine = 0;
  UPDATE interview_types SET dirty = 1 WHERE pristine = 0;
  UPDATE journals SET dirty = 1 WHERE pristine = 0 AND record_id IS NOT NULL;
  `,
  // ── v10 (FUTURE) — FTS5 full-text index (§3 mandates FTS5 for search) ──
  // The published wa-sqlite 1.0.0 wasm builds are compiled WITHOUT the FTS5
  // module, so creating this table fails today ("no such module: fts5"). When we
  // ship an FTS5-enabled wasm, append the migration below as a forward-only step
  // and switch LocalDb.search() over to it; until then search() uses LIKE.
  //
  //   CREATE VIRTUAL TABLE entries_fts USING fts5(
  //     title, body_text, content='entries', content_rowid='rowid'
  //   );
  //   + AFTER INSERT/UPDATE/DELETE triggers to keep it in lockstep, then
  //     INSERT INTO entries_fts(entries_fts) VALUES('rebuild');
];

