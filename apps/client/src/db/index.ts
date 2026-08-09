// Main-thread handle to the local SQLite source of truth (CLAUDE.md §5a).
// Spawns the worker, correlates request/response by id, and maps rows to/from
// the JournalEntry shape the rest of the app already speaks. This is the durable
// local store; the in-memory list in state/data.tsx is a reactive mirror of it.
import type { DbRequest, DbResponse, SqlParam, SqlValue } from './protocol';
import type { InterviewType, JournalEntry, MediaAttachment, TemplateRecord } from '../sync/engine';
import type { CoverPattern, Journal } from '../data/sample';

// Distributive omit so each variant of the DbRequest union keeps its own fields
// (a plain Omit<DbRequest, 'id'> would collapse to just the shared `kind`).
type RequestBody = DbRequest extends infer T ? (T extends { id: number } ? Omit<T, 'id'> : never) : never;

// One row of the `entries` table, in column order (see schema.ts v1+v2).
const COLS =
  'id, journal_id, created_at, updated_at, title, body_text, body_json, labels, attachments, deleted, dirty';

function rowToEntry(r: SqlValue[]): JournalEntry {
  const attachments = JSON.parse((r[8] as string) || '[]') as MediaAttachment[];
  return {
    id: r[0] as string,
    journalId: r[1] as string,
    createdAt: r[2] as number,
    updatedAt: r[3] as number,
    title: (r[4] as string) ?? '',
    bodyText: (r[5] as string) ?? '',
    bodyJson: (r[6] as string | null) ?? undefined,
    labels: JSON.parse((r[7] as string) || '[]') as string[],
    attachments: attachments.length ? attachments : undefined,
    deleted: !!(r[9] as number),
  };
}

// Bind values for an upsert, in column order. `dirty` is decided by the caller.
function entryParams(e: JournalEntry, dirty: 0 | 1): SqlParam[] {
  return [
    e.id,
    e.journalId,
    e.createdAt,
    e.updatedAt,
    e.title ?? '',
    e.bodyText ?? '',
    e.bodyJson ?? null,
    JSON.stringify(e.labels ?? []),
    JSON.stringify(e.attachments ?? []),
    e.deleted ? 1 : 0,
    dirty,
  ];
}

const ENTRY_PLACEHOLDERS = '(?,?,?,?,?,?,?,?,?,?,?)';

const UPSERT_SET =
  `journal_id=excluded.journal_id, created_at=excluded.created_at, updated_at=excluded.updated_at, ` +
  `title=excluded.title, body_text=excluded.body_text, body_json=excluded.body_json, ` +
  `labels=excluded.labels, attachments=excluded.attachments, deleted=excluded.deleted, dirty=excluded.dirty`;

// ── template rows (schema v3) ──

const TPL_COLS = 'id, name, body_text, body_json, builtin, pristine, created_at, updated_at, deleted, dirty';

function rowToTemplate(r: SqlValue[]): TemplateRecord {
  return {
    id: r[0] as string,
    name: (r[1] as string) ?? '',
    bodyText: (r[2] as string) ?? '',
    bodyJson: (r[3] as string | null) ?? undefined,
    builtin: (r[4] as string | null) ?? undefined,
    pristine: !!(r[5] as number),
    createdAt: r[6] as number,
    updatedAt: r[7] as number,
    deleted: !!(r[8] as number),
  };
}

function templateParams(t: TemplateRecord, dirty: 0 | 1, pristine: 0 | 1): SqlParam[] {
  return [
    t.id,
    t.name ?? '',
    t.bodyText ?? '',
    t.bodyJson ?? null,
    t.builtin ?? null,
    pristine,
    t.createdAt,
    t.updatedAt,
    t.deleted ? 1 : 0,
    dirty,
  ];
}

const TPL_PLACEHOLDERS = '(?,?,?,?,?,?,?,?,?,?)';

const TPL_UPSERT_SET =
  `name=excluded.name, body_text=excluded.body_text, body_json=excluded.body_json, ` +
  `builtin=excluded.builtin, pristine=excluded.pristine, created_at=excluded.created_at, ` +
  `updated_at=excluded.updated_at, deleted=excluded.deleted, dirty=excluded.dirty`;

// ── interview-type rows (schema v6) ──

const ITV_COLS = 'id, name, intro, prompt, builtin, pristine, created_at, updated_at, deleted, dirty';

function rowToInterviewType(r: SqlValue[]): InterviewType {
  return {
    id: r[0] as string,
    name: (r[1] as string) ?? '',
    intro: (r[2] as string) ?? '',
    prompt: (r[3] as string) ?? '',
    builtin: (r[4] as string | null) ?? undefined,
    pristine: !!(r[5] as number),
    createdAt: r[6] as number,
    updatedAt: r[7] as number,
    deleted: !!(r[8] as number),
  };
}

function interviewTypeParams(t: InterviewType, dirty: 0 | 1, pristine: 0 | 1): SqlParam[] {
  return [
    t.id,
    t.name ?? '',
    t.intro ?? '',
    t.prompt ?? '',
    t.builtin ?? null,
    pristine,
    t.createdAt,
    t.updatedAt,
    t.deleted ? 1 : 0,
    dirty,
  ];
}

const ITV_PLACEHOLDERS = '(?,?,?,?,?,?,?,?,?,?)';

const ITV_UPSERT_SET =
  `name=excluded.name, intro=excluded.intro, prompt=excluded.prompt, ` +
  `builtin=excluded.builtin, pristine=excluded.pristine, created_at=excluded.created_at, ` +
  `updated_at=excluded.updated_at, deleted=excluded.deleted, dirty=excluded.dirty`;

// ── journal rows (schema v5 + v8 sync bookkeeping) ──
// Journals sync through the entry oplog (kind: 'journal' inside the ciphertext).
// record_id is the random cleartext oplog id; the journal id itself never
// leaves the ciphertext (§3 — sample ids are well-known, user ids date-encoded).

const JOURNAL_COLS = 'id, name, subtitle, color, cover, created_at, updated_at, deleted, pristine, dirty, record_id';

function rowToJournal(r: SqlValue[]): Journal {
  return {
    id: r[0] as string,
    name: (r[1] as string) ?? '',
    subtitle: (r[2] as string) ?? '',
    color: (r[3] as string) ?? '',
    cover: ((r[4] as string) || 'plain') as CoverPattern,
    createdAt: r[5] as number,
    updatedAt: (r[6] as number) || (r[5] as number),
    deleted: !!(r[7] as number),
    pristine: !!(r[8] as number),
    recordId: (r[10] as string | null) ?? undefined,
    // Derived live from the entries by the provider (journalsWithCounts).
    count: 0,
    last: '',
  };
}

function journalParams(j: Journal, dirty: 0 | 1, pristine: 0 | 1): SqlParam[] {
  return [
    j.id,
    j.name ?? '',
    j.subtitle ?? '',
    j.color ?? '',
    j.cover ?? 'plain',
    j.createdAt ?? Date.now(),
    j.updatedAt ?? j.createdAt ?? Date.now(),
    j.deleted ? 1 : 0,
    pristine,
    dirty,
    j.recordId ?? null,
  ];
}

const JOURNAL_PLACEHOLDERS = '(?,?,?,?,?,?,?,?,?,?,?)';

const JOURNAL_UPSERT_SET =
  `name=excluded.name, subtitle=excluded.subtitle, color=excluded.color, cover=excluded.cover, ` +
  `created_at=excluded.created_at, updated_at=excluded.updated_at, deleted=excluded.deleted, ` +
  `pristine=excluded.pristine, dirty=excluded.dirty, record_id=excluded.record_id`;

// ── media rows (schema v2): plaintext bytes + upload-outbox flag ──

export interface MediaRecord {
  id: string;
  entryId: string;
  mime: string;
  bytes: number;
  durationMs?: number;
  createdAt: number;
  data: Uint8Array | null; // NULL until downloaded
  synced: boolean;
}

const MEDIA_COLS = 'id, entry_id, mime, bytes, duration_ms, created_at, data, synced';

function rowToMedia(r: SqlValue[]): MediaRecord {
  return {
    id: r[0] as string,
    entryId: r[1] as string,
    mime: r[2] as string,
    bytes: r[3] as number,
    durationMs: (r[4] as number | null) ?? undefined,
    createdAt: r[5] as number,
    data: (r[6] as Uint8Array | null) ?? null,
    synced: !!(r[7] as number),
  };
}


// ── seeded-record tables (templates + interview_types) ──────────────────────
//
// The two tables are structurally identical (same seven access patterns, same
// flag semantics); the descriptor keeps them from being maintained as slowly
// diverging copies. Adding a synced, seedable record kind = one descriptor.
interface SeededTable<T> {
  table: string;
  cols: string;
  placeholders: string;
  upsertSet: string;
  params(t: T, dirty: 0 | 1, pristine: 0 | 1): SqlParam[];
  fromRow(r: SqlValue[]): T;
}

const TEMPLATE_TABLE: SeededTable<TemplateRecord> = {
  table: 'templates',
  cols: TPL_COLS,
  placeholders: TPL_PLACEHOLDERS,
  upsertSet: TPL_UPSERT_SET,
  params: templateParams,
  fromRow: rowToTemplate,
};

const INTERVIEW_TABLE: SeededTable<InterviewType> = {
  table: 'interview_types',
  cols: ITV_COLS,
  placeholders: ITV_PLACEHOLDERS,
  upsertSet: ITV_UPSERT_SET,
  params: interviewTypeParams,
  fromRow: rowToInterviewType,
};

/**
 * Best-effort removal of a per-owner OPFS directory (`mneme/<ownerId>`). After a
 * phrase rotation the old owner's plaintext DB must not linger on disk — the
 * rotation exists precisely because that identity may be compromised.
 */
export async function destroyOwnerDb(ownerId: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const parent = await root.getDirectoryHandle('mneme');
    await parent.removeEntry(ownerId, { recursive: true });
  } catch {
    /* OPFS unavailable, or the directory never existed */
  }
}

export class LocalDb {
  #worker: Worker | null = null;
  #ownerId: string | null = null;
  #seq = 0;
  #pending = new Map<number, { resolve: (r: DbResponse) => void; reject: (e: Error) => void }>();

  // The worker died (script failed to load under a broken CSP/partial deploy,
  // or crashed mid-session): reject everything in flight instead of leaving
  // open()/queries hanging forever — the caller's catch path degrades to the
  // in-memory session, which a promise that never settles would never reach.
  #fail(message: string): void {
    const err = new Error(message);
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
  }

  #send(req: RequestBody): Promise<DbResponse> {
    const w = this.#worker;
    if (!w) return Promise.reject(new Error('LocalDb not open'));
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      w.postMessage({ ...req, id } as DbRequest);
    });
  }

  async #query(sql: string, params?: SqlParam[]): Promise<SqlValue[][]> {
    const res = await this.#send({ kind: 'query', sql, params });
    if (!res.ok) throw new Error(res.error);
    return res.rows;
  }

  async #run(sql: string, params?: SqlParam[]): Promise<void> {
    const res = await this.#send({ kind: 'run', sql, params });
    if (!res.ok) throw new Error(res.error);
  }

  /** Open (and migrate) the per-owner database. Safe to call once per session. */
  async open(ownerId: string): Promise<void> {
    if (this.#worker) {
      // Callers must close() before re-homing; silently keeping the previous
      // owner's DB open under a new owner id would cross vault boundaries.
      if (this.#ownerId !== ownerId) throw new Error('LocalDb already open for a different owner — close() first');
      return;
    }
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<DbResponse>) => {
      const p = this.#pending.get(ev.data.id);
      if (p) {
        this.#pending.delete(ev.data.id);
        p.resolve(ev.data);
      }
    };
    worker.onerror = (e) => this.#fail(e.message || 'local DB worker failed');
    worker.onmessageerror = () => this.#fail('local DB worker message error');
    this.#worker = worker;
    this.#ownerId = ownerId;
    // base64url ownerId is filesystem-safe; one OPFS directory isolates each account.
    await this.#send({ kind: 'open', dir: `mneme/${ownerId}`, file: 'journal.db' }).then((r) => {
      if (!r.ok) throw new Error(r.error);
    });
  }

  /**
   * Terminate the worker so a different owner's DB can be opened (phrase
   * rotation re-homes the vault under the new owner_id). In-flight requests
   * are rejected; call open() again afterwards.
   */
  close(): void {
    this.#worker?.terminate();
    this.#worker = null;
    this.#ownerId = null;
    this.#fail('LocalDb closed');
  }

  /** All non-deleted entries, newest first — the timeline seed on unlock. */
  async allEntries(): Promise<JournalEntry[]> {
    const rows = await this.#query(
      `SELECT ${COLS} FROM entries WHERE deleted = 0 ORDER BY updated_at DESC`,
    );
    return rows.map(rowToEntry);
  }

  /** Ids of entries still awaiting a relay push (rebuilds the outbox after a reload). */
  async dirtyEntries(): Promise<JournalEntry[]> {
    const rows = await this.#query(`SELECT ${COLS} FROM entries WHERE dirty = 1`);
    return rows.map(rowToEntry);
  }

  /** A local edit: always wins on this device and is marked for the outbox. */
  async putLocal(e: JournalEntry): Promise<void> {
    await this.#run(
      `INSERT INTO entries (${COLS}) VALUES ${ENTRY_PLACEHOLDERS} ` +
        `ON CONFLICT(id) DO UPDATE SET ${UPSERT_SET}`,
      entryParams(e, 1),
    );
  }

  /** Merge relay entries under last-write-wins: only newer versions overwrite (§3). */
  async mergeRemote(entries: JournalEntry[]): Promise<void> {
    if (!entries.length) return;
    const statements = entries.map((e) => ({
      sql:
        `INSERT INTO entries (${COLS}) VALUES ${ENTRY_PLACEHOLDERS} ` +
        `ON CONFLICT(id) DO UPDATE SET ${UPSERT_SET} WHERE excluded.updated_at > entries.updated_at`,
      params: entryParams(e, 0),
    }));
    const res = await this.#send({ kind: 'batch', statements });
    if (!res.ok) throw new Error(res.error);
  }

  /** Clear the dirty flag for versions the relay acknowledged (precise on updated_at). */
  async markSynced(entries: JournalEntry[]): Promise<void> {
    if (!entries.length) return;
    const statements = entries.map((e) => ({
      sql: `UPDATE entries SET dirty = 0 WHERE id = ? AND updated_at = ?`,
      params: [e.id, e.updatedAt] as SqlParam[],
    }));
    const res = await this.#send({ kind: 'batch', statements });
    if (!res.ok) throw new Error(res.error);
  }

  /**
   * Search over titles + bodies, newest matches first. Interim LIKE scan until an
   * FTS5-enabled wasm lands (see schema.ts v2); §3 wants FTS5 to carry this.
   */
  async search(query: string): Promise<JournalEntry[]> {
    const q = query.trim();
    if (!q) return [];
    // Escape LIKE wildcards so user input is matched literally.
    const needle = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const rows = await this.#query(
      `SELECT ${COLS} FROM entries ` +
        `WHERE deleted = 0 AND (title LIKE ? ESCAPE '\\' OR body_text LIKE ? ESCAPE '\\') ` +
        `ORDER BY updated_at DESC`,
      [needle, needle],
    );
    return rows.map(rowToEntry);
  }

  // ── seeded-record tables: templates (v3) + interview types (v6) ──
  // One implementation, two descriptors (TEMPLATE_TABLE / INTERVIEW_TABLE);
  // the public per-kind methods below stay so call sites read naturally.

  /** All non-deleted rows, oldest first (built-in seeds before user records). */
  async #allSeeded<T>(d: SeededTable<T>): Promise<T[]> {
    const rows = await this.#query(
      `SELECT ${d.cols} FROM ${d.table} WHERE deleted = 0 ORDER BY created_at ASC`,
    );
    return rows.map(d.fromRow);
  }

  /** Total rows including tombstones — 0 means this device was never seeded. */
  async #seededCount<T>(d: SeededTable<T>): Promise<number> {
    const rows = await this.#query(`SELECT COUNT(*) FROM ${d.table}`);
    return (rows[0]?.[0] as number) ?? 0;
  }

  /** Rows still awaiting a relay push (rebuilds the outbox after a reload). */
  async #dirtySeeded<T>(d: SeededTable<T>): Promise<T[]> {
    const rows = await this.#query(`SELECT ${d.cols} FROM ${d.table} WHERE dirty = 1`);
    return rows.map(d.fromRow);
  }

  /** A local create/edit/delete: wins on this device, loses pristine, joins the outbox. */
  async #putLocalSeeded<T>(d: SeededTable<T>, t: T): Promise<void> {
    await this.#run(
      `INSERT INTO ${d.table} (${d.cols}) VALUES ${d.placeholders} ` +
        `ON CONFLICT(id) DO UPDATE SET ${d.upsertSet}`,
      d.params(t, 1, 0),
    );
  }

  /** Lay down built-in seeds (pristine, non-dirty). Existing rows — tombstones included — win. */
  async #seedSeeded<T>(d: SeededTable<T>, items: T[]): Promise<void> {
    if (!items.length) return;
    const statements = items.map((t) => ({
      sql: `INSERT OR IGNORE INTO ${d.table} (${d.cols}) VALUES ${d.placeholders}`,
      params: d.params(t, 0, 1),
    }));
    const res = await this.#send({ kind: 'batch', statements });
    if (!res.ok) throw new Error(res.error);
  }

  /** Merge relay rows under last-write-wins: only newer versions overwrite (§3). */
  async #mergeRemoteSeeded<T>(d: SeededTable<T>, items: T[]): Promise<void> {
    if (!items.length) return;
    const statements = items.map((t) => ({
      sql:
        `INSERT INTO ${d.table} (${d.cols}) VALUES ${d.placeholders} ` +
        `ON CONFLICT(id) DO UPDATE SET ${d.upsertSet} WHERE excluded.updated_at > ${d.table}.updated_at`,
      params: d.params(t, 0, 0),
    }));
    const res = await this.#send({ kind: 'batch', statements });
    if (!res.ok) throw new Error(res.error);
  }

  /** Clear the dirty flag for versions the relay acknowledged (precise on updated_at). */
  async #markSeededSynced<T extends { id: string; updatedAt: number }>(d: SeededTable<T>, items: T[]): Promise<void> {
    if (!items.length) return;
    const statements = items.map((t) => ({
      sql: `UPDATE ${d.table} SET dirty = 0 WHERE id = ? AND updated_at = ?`,
      params: [t.id, t.updatedAt] as SqlParam[],
    }));
    const res = await this.#send({ kind: 'batch', statements });
    if (!res.ok) throw new Error(res.error);
  }

  /**
   * Hard-delete pristine built-in seeds that another device's edit/delete of the
   * same built-in has superseded (the seeds were local-only, so no tombstone is
   * needed — the superseding record itself keeps the slug occupied).
   */
  async #dropSeeded<T>(d: SeededTable<T>, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const statements = ids.map((id) => ({
      sql: `DELETE FROM ${d.table} WHERE id = ? AND pristine = 1`,
      params: [id] as SqlParam[],
    }));
    const res = await this.#send({ kind: 'batch', statements });
    if (!res.ok) throw new Error(res.error);
  }

  allTemplates(): Promise<TemplateRecord[]> { return this.#allSeeded(TEMPLATE_TABLE); }
  templateCount(): Promise<number> { return this.#seededCount(TEMPLATE_TABLE); }
  dirtyTemplates(): Promise<TemplateRecord[]> { return this.#dirtySeeded(TEMPLATE_TABLE); }
  putLocalTemplate(t: TemplateRecord): Promise<void> { return this.#putLocalSeeded(TEMPLATE_TABLE, t); }
  seedTemplates(templates: TemplateRecord[]): Promise<void> { return this.#seedSeeded(TEMPLATE_TABLE, templates); }
  mergeRemoteTemplates(templates: TemplateRecord[]): Promise<void> { return this.#mergeRemoteSeeded(TEMPLATE_TABLE, templates); }
  markTemplatesSynced(templates: TemplateRecord[]): Promise<void> { return this.#markSeededSynced(TEMPLATE_TABLE, templates); }
  dropTemplates(ids: string[]): Promise<void> { return this.#dropSeeded(TEMPLATE_TABLE, ids); }

  allInterviewTypes(): Promise<InterviewType[]> { return this.#allSeeded(INTERVIEW_TABLE); }
  interviewTypeCount(): Promise<number> { return this.#seededCount(INTERVIEW_TABLE); }
  dirtyInterviewTypes(): Promise<InterviewType[]> { return this.#dirtySeeded(INTERVIEW_TABLE); }
  putLocalInterviewType(t: InterviewType): Promise<void> { return this.#putLocalSeeded(INTERVIEW_TABLE, t); }
  seedInterviewTypes(types: InterviewType[]): Promise<void> { return this.#seedSeeded(INTERVIEW_TABLE, types); }
  mergeRemoteInterviewTypes(types: InterviewType[]): Promise<void> { return this.#mergeRemoteSeeded(INTERVIEW_TABLE, types); }
  markInterviewTypesSynced(types: InterviewType[]): Promise<void> { return this.#markSeededSynced(INTERVIEW_TABLE, types); }
  dropInterviewTypes(ids: string[]): Promise<void> { return this.#dropSeeded(INTERVIEW_TABLE, ids); }

  // ── journals (schema v5 + v8) ──

  /**
   * Every journal row in creation order, tombstones included — they stay in the
   * provider's raw list so pulled stale copies can't resurrect a deleted
   * notebook (count/last are derived live by the provider).
   */
  async allJournals(): Promise<Journal[]> {
    const rows = await this.#query(`SELECT ${JOURNAL_COLS} FROM journals ORDER BY rowid ASC`);
    return rows.map(rowToJournal);
  }

  /** Total journal rows including tombstones — 0 means this device was never seeded. */
  async journalCount(): Promise<number> {
    const rows = await this.#query(`SELECT COUNT(*) FROM journals`);
    return (rows[0]?.[0] as number) ?? 0;
  }

  /** Journals still awaiting a relay push (rebuilds the outbox after a reload). */
  async dirtyJournals(): Promise<Journal[]> {
    const rows = await this.#query(`SELECT ${JOURNAL_COLS} FROM journals WHERE dirty = 1`);
    return rows.map(rowToJournal);
  }

  /**
   * Unguarded upsert — the provider computes the LWW/pristine merge in memory
   * (journal volume is tiny) and persists the decided row with explicit flags.
   */
  async putJournalRow(j: Journal, flags: { dirty: 0 | 1; pristine: 0 | 1 }): Promise<void> {
    await this.#run(
      `INSERT INTO journals (${JOURNAL_COLS}) VALUES ${JOURNAL_PLACEHOLDERS} ` +
        `ON CONFLICT(id) DO UPDATE SET ${JOURNAL_UPSERT_SET}`,
      journalParams(j, flags.dirty, flags.pristine),
    );
  }

  /** Lay down the sample notebooks once per device (pristine, non-dirty). Existing rows win. */
  async seedJournals(journals: Journal[]): Promise<void> {
    if (!journals.length) return;
    const statements = journals.map((j) => ({
      sql: `INSERT OR IGNORE INTO journals (${JOURNAL_COLS}) VALUES ${JOURNAL_PLACEHOLDERS}`,
      params: journalParams(j, 0, 1),
    }));
    const res = await this.#send({ kind: 'batch', statements });
    if (!res.ok) throw new Error(res.error);
  }

  /** Clear the dirty flag for versions the relay acknowledged (precise on updated_at). */
  async markJournalsSynced(journals: Journal[]): Promise<void> {
    if (!journals.length) return;
    const statements = journals.map((j) => ({
      sql: `UPDATE journals SET dirty = 0 WHERE id = ? AND updated_at = ?`,
      params: [j.id, j.updatedAt ?? 0] as SqlParam[],
    }));
    const res = await this.#send({ kind: 'batch', statements });
    if (!res.ok) throw new Error(res.error);
  }

  // ── media (schema v2) ──

  /** Store a media row (a fresh recording → synced=false; a download → synced=true). */
  async putMedia(m: MediaRecord): Promise<void> {
    await this.#run(
      `INSERT INTO media (${MEDIA_COLS}) VALUES (?,?,?,?,?,?,?,?) ` +
        `ON CONFLICT(id) DO UPDATE SET data=excluded.data, synced=excluded.synced`,
      [m.id, m.entryId, m.mime, m.bytes, m.durationMs ?? null, m.createdAt, m.data, m.synced ? 1 : 0],
    );
  }

  /** One media row (with bytes), or null if this device has never seen/fetched it. */
  async getMedia(id: string): Promise<MediaRecord | null> {
    const rows = await this.#query(`SELECT ${MEDIA_COLS} FROM media WHERE id = ?`, [id]);
    return rows.length ? rowToMedia(rows[0]) : null;
  }

  /** Every media row, bytes included — used to migrate recordings during phrase rotation. */
  async allMedia(): Promise<MediaRecord[]> {
    const rows = await this.#query(`SELECT ${MEDIA_COLS} FROM media`);
    return rows.map(rowToMedia);
  }

  // Metadata columns only: `data` comes back NULL. Callers that need the bytes
  // fetch them one row at a time via getMedia() — a vault holding gigabytes of
  // video must never be materialized into memory wholesale.
  static readonly #MEDIA_META_COLS = 'id, entry_id, mime, bytes, duration_ms, created_at, NULL, synced';

  /** Every media row WITHOUT its bytes — phrase rotation walks these and streams bytes per id. */
  async allMediaMeta(): Promise<MediaRecord[]> {
    const rows = await this.#query(`SELECT ${LocalDb.#MEDIA_META_COLS} FROM media`);
    return rows.map(rowToMedia);
  }

  /** Media rows still awaiting a relay upload (rebuilds the media outbox after a reload). */
  async unsyncedMedia(): Promise<MediaRecord[]> {
    const rows = await this.#query(`SELECT ${MEDIA_COLS} FROM media WHERE synced = 0`);
    return rows.map(rowToMedia);
  }

  /** Like unsyncedMedia, but without the bytes — the outbox holds metadata and
   *  the upload loop streams each row's bytes from the DB when its turn comes. */
  async unsyncedMediaMeta(): Promise<MediaRecord[]> {
    const rows = await this.#query(`SELECT ${LocalDb.#MEDIA_META_COLS} FROM media WHERE synced = 0`);
    return rows.map(rowToMedia);
  }

  /** Clear the media outbox flag once the relay has the full object. */
  async markMediaSynced(id: string): Promise<void> {
    await this.#run(`UPDATE media SET synced = 1 WHERE id = ?`, [id]);
  }

  /** Flip just the outbox flag, leaving the stored bytes untouched — putMedia
   *  would overwrite `data` with whatever the caller holds, which for a
   *  metadata-only row is NULL (destroying the local copy). */
  async setMediaSynced(id: string, synced: boolean): Promise<void> {
    await this.#run(`UPDATE media SET synced = ? WHERE id = ?`, [synced ? 1 : 0, id]);
  }

  /** Drop a recording's bytes for good (the user confirmed deleting the attachment). */
  async deleteMedia(id: string): Promise<void> {
    await this.#run(`DELETE FROM media WHERE id = ?`, [id]);
  }

  /** The cached downscaled thumbnail of an image (schema v7), or null if not generated yet. */
  async getMediaThumb(id: string): Promise<Uint8Array | null> {
    const rows = await this.#query(`SELECT thumb FROM media WHERE id = ?`, [id]);
    return rows.length ? ((rows[0][0] as Uint8Array | null) ?? null) : null;
  }

  /** Persist a generated thumbnail next to its media row (no-op if the row is gone). */
  async putMediaThumb(id: string, thumb: Uint8Array): Promise<void> {
    await this.#run(`UPDATE media SET thumb = ? WHERE id = ?`, [thumb, id]);
  }

  // ── media tombstones (schema v4): relay-side deletion queue ──

  /** Queue a media id for relay-side deletion (survives reloads until acknowledged). */
  async addMediaTombstone(id: string): Promise<void> {
    await this.#run(`INSERT OR IGNORE INTO media_tombstones (id, created_at) VALUES (?, ?)`, [id, Date.now()]);
  }

  /** Media ids still awaiting relay-side deletion (rebuilds the queue after a reload). */
  async mediaTombstones(): Promise<string[]> {
    const rows = await this.#query(`SELECT id FROM media_tombstones`);
    return rows.map((r) => r[0] as string);
  }

  /** The relay acknowledged the deletion — the tombstone has done its job. */
  async clearMediaTombstone(id: string): Promise<void> {
    await this.#run(`DELETE FROM media_tombstones WHERE id = ?`, [id]);
  }
}
