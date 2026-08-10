// Message protocol between the main thread (db/index.ts) and the SQLite worker.
// The worker owns the only SQLite connection — OPFS sync access handles are
// worker-only — so every read/write crosses this boundary as a request/response
// pair correlated by a monotonic `id`.

// Uint8Array binds/reads as a SQLite BLOB — media bytes live in the `media`
// table (schema v2). postMessage structured-clones it across the boundary.
export type SqlParam = string | number | Uint8Array | null;

export type SqlValue = string | number | Uint8Array | null;

export type DbRequest =
  | { id: number; kind: 'open'; dir: string; file: string }
  | { id: number; kind: 'run'; sql: string; params?: SqlParam[] }
  | { id: number; kind: 'query'; sql: string; params?: SqlParam[] }
  | { id: number; kind: 'batch'; statements: { sql: string; params?: SqlParam[] }[] };

export type DbResponse =
  | { id: number; ok: true; rows: SqlValue[][] }
  | { id: number; ok: false; error: string };
