// The SQLite worker. It owns the only database connection because the OPFS
// synchronous access-handle API (used by AccessHandlePoolVFS) is available only
// inside a Worker — and that VFS needs no COOP/COEP cross-origin isolation,
// which is exactly why §3 reaches for the COOP-free synchronous OPFS path.
//
// (§3 names `OPFSCoopSyncVFS`; that class ships only in wa-sqlite's unpublished
// 2.x line. AccessHandlePoolVFS is the published-1.0.0 equivalent — synchronous,
// OPFS-backed, COOP/COEP-free — so it honours the decision's intent.)
import * as SQLite from 'wa-sqlite';
import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite.mjs';
import { AccessHandlePoolVFS } from 'wa-sqlite/src/examples/AccessHandlePoolVFS.js';
import wasmUrl from 'wa-sqlite/dist/wa-sqlite.wasm?url';
import { MIGRATIONS } from './schema';
import type { DbRequest, DbResponse, SqlParam, SqlValue } from './protocol';

let sqlite3: SQLiteAPI | null = null;
let db = 0;

type SQLiteAPI = ReturnType<typeof SQLite.Factory>;

// Run a single statement; collect any result rows (most writes return none).
async function exec(sql: string, params?: SqlParam[]): Promise<{ rows: SqlValue[][] }> {
  const api = sqlite3!;
  const rows: SqlValue[][] = [];
  for await (const stmt of api.statements(db, sql)) {
    if (params && params.length) api.bind_collection(stmt, params);
    while ((await api.step(stmt)) === SQLite.SQLITE_ROW) {
      rows.push(api.row(stmt) as SqlValue[]);
    }
  }
  return { rows };
}

async function open(dir: string, file: string): Promise<void> {
  if (db) return;
  const module = await SQLiteESMFactory({ locateFile: () => wasmUrl });
  sqlite3 = SQLite.Factory(module);

  // One flat OPFS directory per owner keeps accounts isolated on disk.
  const vfs = new AccessHandlePoolVFS(dir);
  await vfs.isReady;
  // The example VFS implements the runtime VFS contract; its example-file typings
  // diverge slightly from the published SQLiteVFS interface, so cast at the seam.
  sqlite3.vfs_register(vfs as unknown as Parameters<SQLiteAPI['vfs_register']>[0], true);

  db = await sqlite3.open_v2(file);

  // Forward-only migrations, gated on user_version (§11). Each runs in its own
  // transaction (DDL is transactional in SQLite) so a failure rolls back fully
  // and leaves user_version untouched — a half-applied schema never persists.
  const [[current]] = (await exec('PRAGMA user_version')).rows as [number][];
  for (let v = current; v < MIGRATIONS.length; v++) {
    await exec('BEGIN');
    try {
      await exec(MIGRATIONS[v]);
      await exec(`PRAGMA user_version = ${v + 1}`);
      await exec('COMMIT');
    } catch (e) {
      await exec('ROLLBACK');
      throw e;
    }
  }
}

async function handle(req: DbRequest): Promise<{ rows: SqlValue[][] }> {
  switch (req.kind) {
    case 'open':
      await open(req.dir, req.file);
      return { rows: [] };
    case 'run':
    case 'query':
      return exec(req.sql, req.params);
    case 'batch': {
      // Wrap a multi-write batch in a transaction so a partial failure rolls back.
      await exec('BEGIN');
      try {
        for (const s of req.statements) await exec(s.sql, s.params);
        await exec('COMMIT');
      } catch (e) {
        await exec('ROLLBACK');
        throw e;
      }
      return { rows: [] };
    }
  }
}

// Serialize every request through one promise chain. There is a single SQLite
// connection, and `exec` yields at each `await` (statements/step); an unguarded
// async onmessage would let requests interleave on that one connection. That is
// corrupting for `batch` ops in particular: a batch wraps its writes in
// BEGIN…COMMIT, so any other request's writes that interleave land inside that
// transaction — and a second overlapping BEGIN throws, triggering a ROLLBACK
// that discards them. A bulk Day One import (hundreds of putLocal writes racing
// with each flush's markSynced batches) is where this surfaced: most inserts
// were rolled back and only a handful survived. Chaining keeps each request
// fully done before the next begins.
let queue: Promise<unknown> = Promise.resolve();

self.onmessage = (ev: MessageEvent<DbRequest>) => {
  const req = ev.data;
  queue = queue.then(async () => {
    try {
      const { rows } = await handle(req);
      const res: DbResponse = { id: req.id, ok: true, rows };
      (self as unknown as Worker).postMessage(res);
    } catch (e) {
      const res: DbResponse = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
      (self as unknown as Worker).postMessage(res);
    }
  });
};
