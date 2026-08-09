// Pure helpers for the AppData provider (state/data.tsx) — everything here is
// side-effect-free and unit-testable without Preact. The provider composes
// these; nothing in this module touches state, refs, or the DOM.
import { RelayError } from '../sync/relay';
import type { JournalRecord } from '../sync/engine';
import type { JournalEntry } from '../sync/engine';
import { ENTRIES, JOURNALS, type Journal, type CoverPattern } from '../data/sample';
import { blocksToDoc, textToDoc, docToText } from '../editor/doc';
import { t, tp, fmtDate } from '../i18n';

// A sync failure is either connectivity (expected — the relay is down or the
// device is offline; retried quietly) or a real defect (a serialization bug, a
// 4xx the relay will return forever). Both drop the status to 'offline' so the
// reconnect loop keeps running, but a defect must be VISIBLE in the console —
// swallowing it as "offline" hides bugs indefinitely. Never log record
// contents here: the error itself carries only exception/relay text, no
// journal plaintext or keys.
export function isConnectivityError(e: unknown): boolean {
  // fetch() rejects with a TypeError when the network is unreachable; relay
  // 5xx/429 are server-side conditions that resolve themselves.
  if (e instanceof TypeError) return true;
  return e instanceof RelayError && (e.status >= 500 || e.status === 429);
}

export function logSyncError(op: 'flush' | 'pull', e: unknown): void {
  if (isConnectivityError(e)) return; // routine; the offline indicator covers it
  console.error(`[sync] ${op} failed with a non-connectivity error:`, e);
}

// Local persistence is fire-and-forget for UI latency, but a failed OPFS write
// (disk pressure is realistic for video vaults) must not be silent: the UI and
// the outbox would report an entry saved that doesn't exist after reload.
// Logs only the error — never the record being written.
export function logDbWrite(e: unknown): void {
  console.error('[db] local write failed:', e);
}

// Cheap equality so the per-journal pending set only triggers a re-render when
// its membership actually changes (syncPendingCount fires on every outbox poke).
export function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// Seed the timeline with the Tutorial walkthrough entries on a fresh vault.
// These stay local (not pushed); only user-created entries sync to the relay.
export function seedEntries(): JournalEntry[] {
  return ENTRIES.map((e) => {
    const [h, m] = e.time.split(':').map(Number);
    const at = Date.UTC(2026, 5, e.day, h || 0, m || 0);
    // Tutorial entries carry rich block bodies (real TipTap content, so the
    // editor opens with the features they describe); anything without blocks
    // starts from its one-line preview text.
    const doc = e.blocks ? blocksToDoc(e.blocks) : textToDoc(e.preview);
    return {
      id: e.id,
      journalId: e.journal,
      title: e.title,
      bodyText: e.blocks ? docToText(doc) : e.preview,
      bodyJson: JSON.stringify(doc),
      labels: e.labels,
      createdAt: at,
      updatedAt: at,
    };
  });
}

// Sample notebooks as seed rows — pristine and local-only until the first edit
// makes one a real synced record (mirrors the template/interview-type seeds).
export function seedJournalRows(now: number): Journal[] {
  return JOURNALS.map((j) => ({ ...j, createdAt: now, updatedAt: now, pristine: true }));
}

const COVER_PATTERNS: readonly string[] = ['lines', 'dots', 'grid', 'plain', 'photo'];

// A pulled journal record, shaped for the UI list. Cover strings from the wire
// are validated back into the CoverPattern union (fail-safe to 'plain').
export function journalFromRecord(r: JournalRecord): Journal {
  return {
    id: r.id,
    name: r.name,
    subtitle: r.subtitle,
    color: r.color,
    cover: (COVER_PATTERNS.includes(r.cover) ? r.cover : 'plain') as CoverPattern,
    count: 0,
    last: '',
    recordId: r.recordId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deleted: r.deleted,
  };
}

// The wire shape of a local journal (what the outbox pushes). Callers guarantee
// recordId is minted; count/last never leave the device.
export function journalToRecord(j: Journal): JournalRecord {
  const created = j.createdAt ?? j.updatedAt ?? 0;
  return {
    id: j.id,
    recordId: j.recordId,
    name: j.name,
    subtitle: j.subtitle,
    color: j.color,
    cover: j.cover,
    createdAt: created,
    updatedAt: j.updatedAt ?? created,
    deleted: j.deleted,
  };
}

// Concurrent first-syncs of the same journal mint different record ids on each
// device. Receivers adopt the smallest id they have seen so every device
// converges onto one record; the losers go stale on the relay and lose LWW.
export function adoptRecordId(local: string | undefined, pulled: string | undefined): string | undefined {
  if (!local) return pulled;
  if (!pulled) return local;
  return pulled < local ? pulled : local;
}

export function mergeByLWW<T extends { id: string; updatedAt: number }>(prev: T[], incoming: T[]): T[] {
  const byId = new Map(prev.map((e) => [e.id, e]));
  for (const e of incoming) {
    const cur = byId.get(e.id);
    if (!cur || e.updatedAt > cur.updatedAt) byId.set(e.id, e);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

// Blob wants a plain ArrayBuffer; bytes from the DB/crypto layers are typed over
// ArrayBufferLike, so copy into a fresh buffer (also detaches any subarray view).
export function bytesToBlob(data: Uint8Array, type: string): Blob {
  const copy = new Uint8Array(data.length);
  copy.set(data);
  return new Blob([copy.buffer], { type });
}

// Local-midnight of a timestamp, so "days ago" counts calendar days, not 24h spans.
function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// New entries are headlined with their local creation time ("2026-06-12 14:03:55")
// instead of starting untitled.
export function defaultEntryTitle(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// A short relative label for a notebook's most-recent edit ("Today", "3 days ago",
// "12 Jun"). `last` was a hardcoded sample string; this derives it from real data.
export function relativeDay(ts: number, now: number): string {
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(ts)) / 86_400_000);
  if (days <= 0) return t('common.today');
  if (days === 1) return t('common.yesterday');
  if (days < 7) return tp('shell.daysAgo', days);
  if (days < 14) return t('shell.lastWeek');
  return fmtDate(ts, { day: 'numeric', month: 'short' });
}

/**
 * A synced copy of a built-in (someone edited or deleted it on another device)
 * retires this device's untouched pristine seed of the same built-in — the two
 * carry different random ids, so LWW alone can't pair them. Returns the merged
 * list with superseded seeds removed, plus their ids for the DB drop.
 */
export function supersedeBuiltinSeeds<T extends { id: string; pristine?: boolean; builtin?: string }>(
  merged: T[],
  incoming: T[],
): { list: T[]; dropped: string[] } {
  const syncedSlugs = new Set(incoming.filter((t) => t.builtin).map((t) => t.builtin));
  const dropped = merged.filter((t) => t.pristine && t.builtin && syncedSlugs.has(t.builtin)).map((t) => t.id);
  if (dropped.length === 0) return { list: merged, dropped };
  const gone = new Set(dropped);
  return { list: merged.filter((t) => !gone.has(t.id)), dropped };
}
