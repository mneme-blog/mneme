// Regression check for the badge engine (state/badges.ts): every rule over
// synthetic entries — seed exclusion, streak/word thresholds, the parse-confirm
// step behind the string pre-filters — plus the seen-state lifecycle: quiet
// catch-up on first evaluation, delta celebration afterwards, corrupt-JSON
// fail-safe, and the save/load round-trip against a mocked localStorage.
// Run: pnpm --filter client exec tsx scripts/badges-repro.ts
import {
  BADGE_ORDER,
  SEED_ENTRY_IDS,
  evaluateBadges,
  userEntries,
  catchUpOrDelta,
  loadSeen,
  saveSeen,
  seenKey,
  type BadgeId,
} from '../src/state/badges';
import { ENTRIES } from '../src/data/sample';
import type { JournalEntry } from '../src/sync/engine';

let failures = 0;
function check(label: string, ok: boolean): void {
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${label}`);
  } else {
    console.log(`  ok    ${label}`);
  }
}

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 6, 1, 12, 0); // noon, mid-day so day math is unambiguous
let n = 0;
function entry(over: Partial<JournalEntry> = {}): JournalEntry {
  n++;
  return {
    id: `test-${n}`,
    journalId: 'j-personal',
    title: `Entry ${n}`,
    bodyText: 'a quiet day',
    labels: [],
    createdAt: BASE + n * DAY,
    updatedAt: BASE + n * DAY,
    ...over,
  };
}
const earnedOf = (entries: JournalEntry[], types: string[] = []): Set<BadgeId> => evaluateBadges(entries, types);
const only = (earned: Set<BadgeId>, ...ids: BadgeId[]): boolean =>
  earned.size === ids.length && ids.every((id) => earned.has(id));

// ── seed exclusion ──
const seeds: JournalEntry[] = ENTRIES.map((e) => entry({ id: e.id, bodyText: 'tutorial words '.repeat(200) }));
check('sample ids are the seed set', ENTRIES.every((e) => SEED_ENTRY_IDS.has(e.id)));
check('seed-only vault earns nothing', earnedOf(seeds).size === 0);
check('userEntries drops seeds and tombstones', userEntries([...seeds, entry(), entry({ deleted: true })]).length === 1);

// ── first-words ──
check('one user entry → first-words only', only(earnedOf([entry()]), 'first-words'));

// ── streaks (consecutive UTC days) ──
const run = (days: number): JournalEntry[] =>
  Array.from({ length: days }, (_, i) => entry({ createdAt: BASE + i * DAY, updatedAt: BASE + i * DAY }));
check('3-day run → streak-3, not streak-7', only(earnedOf(run(3)), 'first-words', 'streak-3'));
check('6-day run → not streak-7', !earnedOf(run(6)).has('streak-7'));
check('7-day run → streak-7', earnedOf(run(7)).has('streak-7'));
check('3 same-day entries are no streak', !earnedOf([entry({ createdAt: BASE }), entry({ createdAt: BASE + 1 }), entry({ createdAt: BASE + 2 })]).has('streak-3'));

// ── word thresholds ──
const words = (k: number): string => Array.from({ length: k }, (_, i) => `w${i}`).join(' ');
check('999 words total → no wordsmith', !earnedOf([entry({ bodyText: words(500) }), entry({ bodyText: words(499) })]).has('wordsmith'));
check('1000 words across entries → wordsmith, no deep-dive', (() => {
  const e = earnedOf([entry({ bodyText: words(500) }), entry({ bodyText: words(500) })]);
  return e.has('wordsmith') && !e.has('deep-dive');
})());
check('single 1000-word entry → deep-dive', earnedOf([entry({ bodyText: words(1000) })]).has('deep-dive'));
check('single 999-word entry → no deep-dive', !earnedOf([entry({ bodyText: words(999) })]).has('deep-dive'));

// ── first-interview (label ∩ live type names) ──
check('label matching a type name → first-interview', earnedOf([entry({ labels: ['Daily check-in'] })], ['Daily check-in']).has('first-interview'));
check('no type names (all tombstoned) → no first-interview', !earnedOf([entry({ labels: ['Daily check-in'] })], []).has('first-interview'));
check('unrelated label → no first-interview', !earnedOf([entry({ labels: ['travel'] })], ['Daily check-in']).has('first-interview'));

// ── on-camera: the parse step must beat the string pre-filter ──
const viDoc = JSON.stringify({
  type: 'doc',
  content: [{ type: 'videoInterview', attrs: { sessionId: 's1', typeName: 'Daily', cards: [], film: null } }],
});
check('videoInterview node → on-camera', earnedOf([entry({ bodyJson: viDoc })]).has('on-camera'));
const mentionDoc = JSON.stringify({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'reading about the "videoInterview" node today' }] }],
});
check('mentioning "videoInterview" in text → NOT on-camera', !earnedOf([entry({ bodyJson: mentionDoc })]).has('on-camera'));

// ── memory-keeper: inline nodes and the legacy attachments array ──
const mediaDoc = JSON.stringify({
  type: 'doc',
  content: [{ type: 'mediaAttachment', attrs: { id: 'abc123', kind: 'image', mime: 'image/webp', bytes: 1 } }],
});
check('inline media node → memory-keeper', earnedOf([entry({ bodyJson: mediaDoc })]).has('memory-keeper'));
check('legacy attachments array → memory-keeper', earnedOf([entry({ attachments: [{ id: 'm1', kind: 'audio', mime: 'audio/webm', bytes: 9, createdAt: BASE }] })]).has('memory-keeper'));
check('plain entry → no memory-keeper', !earnedOf([entry()]).has('memory-keeper'));
// A clip-less interview passes the node pre-filter but has no media ids — the
// docMediaIds confirmation must keep memory-keeper off.
check('videoInterview without clips → no memory-keeper', !earnedOf([entry({ bodyJson: viDoc })]).has('memory-keeper'));

// ── seen-state lifecycle against a mocked localStorage ──
function mockStore(): Pick<Storage, 'getItem' | 'setItem'> & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}
const store = mockStore();
const OWNER = 'owner-a';

check('absent key loads as null (catch-up signal)', loadSeen(store, OWNER) === null);
const earnedNow = new Set<BadgeId>(['first-words', 'wordsmith']);
const catchUp = catchUpOrDelta(null, earnedNow);
check('catch-up celebrates nothing', catchUp.celebrate.length === 0);
check('catch-up adopts the earned set', only(catchUp.seen, 'first-words', 'wordsmith'));
saveSeen(store, OWNER, catchUp.seen);
check('round-trip restores the set', only(loadSeen(store, OWNER)!, 'first-words', 'wordsmith'));

const delta = catchUpOrDelta(loadSeen(store, OWNER), new Set<BadgeId>(['first-words', 'wordsmith', 'streak-3', 'deep-dive']));
check('delta celebrates only the new ids, in badge order', delta.celebrate.join(',') === 'streak-3,deep-dive');
check('delta keeps prior seen intact', delta.seen.has('first-words') && !delta.seen.has('streak-3'));

check('other owner is unaffected', loadSeen(store, 'owner-b') === null);
store.m.set(seenKey(OWNER), '{corrupt');
check('corrupt JSON reads as catch-up (null)', loadSeen(store, OWNER) === null);
store.m.set(seenKey(OWNER), JSON.stringify(['first-words', 'not-a-badge']));
check('unknown ids are filtered on load', only(loadSeen(store, OWNER)!, 'first-words'));

const throwing: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: () => {
    throw new Error('denied');
  },
  setItem: () => {
    throw new Error('denied');
  },
};
check('throwing storage: load → null', loadSeen(throwing, OWNER) === null);
saveSeen(throwing, OWNER, new Set(['first-words'])); // must not throw
check('throwing storage: save is best-effort', true);

check('BADGE_ORDER covers every badge exactly once', new Set(BADGE_ORDER).size === 8 && BADGE_ORDER.length === 8);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
