// Day One import PERSISTENCE roundtrip — real SQLite, no relay or browser.
//   pnpm --filter client exec tsx scripts/dayone-import-persist.ts
//
// The sibling `dayone-import.ts` validates the parse + document conversion against
// an in-memory mock; it deliberately never touches the SQLite layer, which is why
// it stayed green while a real 101-entry import landed only a handful of rows.
//
// This test closes that gap. It drives the REAL parseDayOneArchive + importDayOne
// over a 101-entry export, writing through a real wa-sqlite database under the
// EXACT dispatch contract `src/db/worker.ts` implements — and reproduces the bulk
// workload that exposed the bug: createEntry/updateEntry each fire-and-forget a
// `putLocal` (a `run`) while `flush()` fires `markSynced` (a `batch`, i.e.
// BEGIN…COMMIT). With the worker's request queue REMOVED, those interleave on the
// single connection and SQLite either rolls writes back inside a stray
// transaction or traps the wasm outright; with the queue in place every row
// round-trips. The assertion: 101 entries in → 101 rows persisted.
//
// NB: the dispatch below mirrors worker.ts. If you change the worker's
// serialization, mirror it here — and if you are tempted to drop the queue,
// this test is the reason not to.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import * as SQLite from 'wa-sqlite';
import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite.mjs';
import { parseDayOneArchive } from '../src/import/dayone';
import { importDayOne, type ImportApi } from '../src/import/run';
import { MIGRATIONS } from '../src/db/schema';
import type { MediaAttachment } from '../src/sync/engine';
import type { Journal } from '../src/data/sample';

// ── A minimal worker, faithful to src/db/worker.ts ───────────────────────────
// One SQLite connection, the same exec/handle, and the same serializing queue.

type Req =
  | { kind: 'run' | 'query'; sql: string; params?: unknown[] }
  | { kind: 'batch'; statements: { sql: string; params?: unknown[] }[] };

async function makeWorker() {
  const wasmBinary = readFileSync(
    fileURLToPath(new URL('../node_modules/wa-sqlite/dist/wa-sqlite.wasm', import.meta.url)),
  );
  const mod = await SQLiteESMFactory({ wasmBinary });
  const api = SQLite.Factory(mod);
  const db = await api.open_v2(':memory:');

  // mirrors worker.ts exec()
  async function exec(sql: string, params?: unknown[]): Promise<unknown[][]> {
    const rows: unknown[][] = [];
    for await (const stmt of api.statements(db, sql)) {
      if (params && params.length) api.bind_collection(stmt, params as Parameters<typeof api.bind_collection>[1]);
      while ((await api.step(stmt)) === SQLite.SQLITE_ROW) rows.push(api.row(stmt));
    }
    return rows;
  }
  // mirrors worker.ts handle()
  async function handle(req: Req): Promise<unknown[][]> {
    if (req.kind !== 'batch') return exec(req.sql, req.params);
    await exec('BEGIN');
    try {
      for (const s of req.statements) await exec(s.sql, s.params);
      await exec('COMMIT');
    } catch (e) {
      await exec('ROLLBACK');
      throw e;
    }
    return [];
  }
  // mirrors worker.ts onmessage: every request chained through one queue.
  let queue: Promise<unknown> = Promise.resolve();
  const inflight: Promise<unknown>[] = [];
  function post(req: Req): Promise<unknown[][]> {
    const p = queue.then(() => handle(req));
    queue = p.catch(() => {});
    inflight.push(p);
    return p as Promise<unknown[][]>;
  }
  // Wait for every fire-and-forget write to drain (the app does this implicitly
  // by reloading from the DB; the test does it explicitly before counting).
  const drain = () => Promise.allSettled(inflight.splice(0));

  // Apply the real forward-only migrations, each in its own transaction.
  for (const m of MIGRATIONS) await post({ kind: 'batch', statements: [{ sql: m }] });
  await drain();
  return { post, drain, exec };
}

// ── A LocalDb subset whose SQL matches src/db/index.ts exactly ───────────────

const COLS =
  'id, journal_id, created_at, updated_at, title, body_text, body_json, labels, attachments, deleted, dirty';
const PLACEHOLDERS = '(?,?,?,?,?,?,?,?,?,?,?)';
const UPSERT_SET =
  `journal_id=excluded.journal_id, created_at=excluded.created_at, updated_at=excluded.updated_at, ` +
  `title=excluded.title, body_text=excluded.body_text, body_json=excluded.body_json, ` +
  `labels=excluded.labels, attachments=excluded.attachments, deleted=excluded.deleted, dirty=excluded.dirty`;

interface Entry {
  id: string;
  journalId: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  bodyText?: string;
  bodyJson?: string;
  labels?: string[];
  attachments?: MediaAttachment[];
  deleted?: boolean;
}

const entryParams = (e: Entry, dirty: 0 | 1): unknown[] => [
  e.id, e.journalId, e.createdAt, e.updatedAt, e.title ?? '', e.bodyText ?? '',
  e.bodyJson ?? null, JSON.stringify(e.labels ?? []), JSON.stringify(e.attachments ?? []),
  e.deleted ? 1 : 0, dirty,
];

// ── Synthetic 101-entry export (one notebook, like a real Day One "Journal") ──

const entries = Array.from({ length: 101 }, (_, i) => ({
  uuid: `U${i}`,
  creationDate: new Date(Date.UTC(2022, 0, 1 + i)).toISOString(),
  tags: i % 2 ? ['daily'] : [],
  // a couple of entries carry an image so media writes interleave too
  text:
    `# Entry ${i}\n\nBody line for entry number ${i}.` +
    (i % 7 === 0 ? `\n\n![](dayone-moment://IMG${i})` : ''),
  ...(i % 7 === 0 ? { photos: [{ identifier: `IMG${i}`, md5: `md5${i}`, type: 'jpeg' as const }] } : {}),
}));

const files: Record<string, Uint8Array> = {
  'Journal.json': strToU8(JSON.stringify({ metadata: { version: '1.0' }, entries })),
};
for (let i = 0; i < 101; i += 7) files[`photos/md5${i}.jpeg`] = new Uint8Array([1, 2, 3, 4]);
const zip = zipSync(files);

const archive = parseDayOneArchive(zip);
assert.equal(archive.entryCount, 101, 'parser sees all 101 entries');
console.log('✓ parse: 1 journal, 101 entries');

// ── Wire the import to the real DB exactly like state/data.tsx ────────────────
// createEntry/updateEntry write through fire-and-forget puts, and each one fires a
// markSynced batch the way `void flush()` does — this is the interleaving that
// the worker queue must absorb.

const worker = await makeWorker();
let seq = 0;
const mem = new Map<string, Entry>();

const markSynced = (e: Entry) =>
  void worker.post({ kind: 'batch', statements: [{ sql: 'UPDATE entries SET dirty=0 WHERE id=? AND updated_at=?', params: [e.id, e.updatedAt] }] });

const putLocal = (e: Entry) =>
  void worker.post({
    kind: 'run',
    sql: `INSERT INTO entries (${COLS}) VALUES ${PLACEHOLDERS} ON CONFLICT(id) DO UPDATE SET ${UPSERT_SET}`,
    params: entryParams(e, 1),
  });

const api: ImportApi = {
  journals: [] as Journal[],
  newJournal() {},
  createEntry(input) {
    const now = Date.now() + ++seq; // strictly increasing, like the app's clock
    const e: Entry = { id: `e${seq}`, journalId: input.journalId, createdAt: now, updatedAt: now, title: input.title, labels: input.labels };
    mem.set(e.id, e);
    putLocal(e);   // void db.putLocal(...)
    markSynced(e); // void flush() → db.markSynced(...)
    return { id: e.id };
  },
  updateEntry(id, patch) {
    const cur = mem.get(id);
    if (!cur) return;
    const next: Entry = { ...cur, ...patch, updatedAt: Date.now() + ++seq };
    mem.set(id, next);
    putLocal(next);
    markSynced(next);
  },
  async addMedia(_entryId, kind, blob) {
    const att: MediaAttachment = { id: `m${++seq}`, kind, mime: blob.type, bytes: (await blob.arrayBuffer()).byteLength, createdAt: 0 };
    return att;
  },
};

const summary = await importDayOne(archive, api, undefined, (bytes, mime) => new Blob([bytes as BlobPart], { type: mime }));
assert.equal(summary.entries, 101, 'import reports 101 entries');

// The crux: drain every fire-and-forget write, then count what actually persisted.
await worker.drain();
const rows = await worker.exec('SELECT COUNT(*) FROM entries');
const persisted = rows[0][0] as number;
console.log(`✓ persisted ${persisted} of 101 rows`);
assert.equal(persisted, 101, 'every imported entry survived to the local DB');

// And every row is intact (title + body round-tripped, not a half-written shell).
const sample = await worker.exec('SELECT title, body_text FROM entries WHERE id=?', ['e1']);
assert.ok((sample[0][0] as string).length > 0 && (sample[0][1] as string).length > 0, 'rows carry their content');

console.log('\nDay One import persistence assertions passed — 101 in, 101 on disk.');
