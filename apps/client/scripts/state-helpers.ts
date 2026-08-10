// Unit checks for the pure provider helpers (state/helpers.ts) — the merge and
// convergence rules that decide which copy of a record wins. These used to be
// inline in the 1,700-line provider where nothing could test them.
// Run: pnpm --filter client exec tsx scripts/state-helpers.ts
import assert from 'node:assert/strict';
import {
  mergeByLWW,
  adoptRecordId,
  supersedeBuiltinSeeds,
  journalFromRecord,
  journalToRecord,
  isConnectivityError,
} from '../src/state/helpers';
import { RelayError } from '../src/sync/relay';

// ── mergeByLWW: newer updatedAt wins; ties keep the existing copy ──
{
  const a1 = { id: 'a', updatedAt: 10, v: 'old' };
  const a2 = { id: 'a', updatedAt: 20, v: 'new' };
  const b = { id: 'b', updatedAt: 15, v: 'b' };
  const merged = mergeByLWW([a1, b], [a2]);
  assert.equal(merged.find((x) => x.id === 'a')?.v, 'new', 'newer copy wins');
  assert.equal(merged.length, 2);
  // Equal clocks: the copy already held wins (no oscillation between devices).
  const tie = mergeByLWW([a2], [{ id: 'a', updatedAt: 20, v: 'rival' }]);
  assert.equal(tie[0].v, 'new', 'tie keeps the local copy');
  // Sorted newest-first.
  assert.deepEqual(merged.map((x) => x.id), ['a', 'b']);
  // A tombstone with a newer clock beats a live copy — deletions must win.
  const del = mergeByLWW(
    [{ id: 'a', updatedAt: 20, deleted: false }],
    [{ id: 'a', updatedAt: 30, deleted: true }],
  );
  assert.equal(del[0].deleted, true, 'newer tombstone wins');
}

// ── adoptRecordId: devices converge onto the smallest id ──
{
  assert.equal(adoptRecordId(undefined, 'bbb'), 'bbb');
  assert.equal(adoptRecordId('aaa', undefined), 'aaa');
  assert.equal(adoptRecordId('bbb', 'aaa'), 'aaa', 'smaller pulled id adopted');
  assert.equal(adoptRecordId('aaa', 'bbb'), 'aaa', 'smaller local id kept');
  assert.equal(adoptRecordId(undefined, undefined), undefined);
}

// ── supersedeBuiltinSeeds: a synced built-in retires the local pristine seed ──
{
  const seed = { id: 'seed-1', pristine: true, builtin: 'daily' };
  const synced = { id: 'real-1', pristine: false, builtin: 'daily' };
  const other = { id: 'seed-2', pristine: true, builtin: 'gratitude' };
  const user: { id: string; pristine: boolean; builtin?: string } = { id: 'user-1', pristine: false };
  const { list, dropped } = supersedeBuiltinSeeds([seed, synced, other, user], [synced]);
  assert.deepEqual(dropped, ['seed-1'], 'only the matching pristine seed retires');
  assert.deepEqual(list.map((t) => t.id).sort(), ['real-1', 'seed-2', 'user-1'].sort());
  // A pristine seed does NOT retire itself when nothing synced matches.
  const none = supersedeBuiltinSeeds([seed, other], [user]);
  assert.deepEqual(none.dropped, []);
  assert.equal(none.list.length, 2);
  // An edited (non-pristine) copy of a built-in never retires.
  const edited = { id: 'mine', pristine: false, builtin: 'daily' };
  const keep = supersedeBuiltinSeeds([edited, synced], [synced]);
  assert.deepEqual(keep.dropped, [], 'forked copies are content, not seeds');
}

// ── journal record mapping: cover validation fails safe; count/last stay local ──
{
  const j = journalFromRecord({
    id: 'j-x', recordId: 'r'.repeat(32), name: 'N', subtitle: 'S', color: '#fff',
    cover: 'not-a-cover', createdAt: 1, updatedAt: 2, deleted: false,
  });
  assert.equal(j.cover, 'plain', 'unknown cover string fails safe');
  assert.equal(j.count, 0);
  const rec = journalToRecord({ ...j, cover: 'dots', count: 99, last: 'Today' });
  assert.equal(rec.cover, 'dots');
  assert.ok(!('count' in rec) || (rec as Record<string, unknown>).count === undefined, 'count never leaves the device');
  // createdAt fallback chain: missing createdAt borrows updatedAt.
  const noCreated = journalToRecord({ ...j, createdAt: undefined, updatedAt: 7, count: 0, last: '' });
  assert.equal(noCreated.createdAt, 7);
}

// ── isConnectivityError: routine outages quiet, defects loud ──
{
  assert.equal(isConnectivityError(new TypeError('fetch failed')), true);
  assert.equal(isConnectivityError(new RelayError(503, 'down')), true);
  assert.equal(isConnectivityError(new RelayError(429, 'slow down')), true);
  assert.equal(isConnectivityError(new RelayError(400, 'bad request')), false, 'a 4xx is a defect');
  assert.equal(isConnectivityError(new RelayError(401, 'no session')), false);
  assert.equal(isConnectivityError(new Error('boom')), false);
}

console.log('All state-helper checks passed.');
