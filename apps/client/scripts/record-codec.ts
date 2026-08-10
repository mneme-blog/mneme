// Field-mapping regression for the wire codec layer (sync/engine.ts).
//
// The oplog carries five record kinds, each hand-projected field by field into
// its encrypted body and back. A field forgotten on EITHER side is silent data
// loss: the next LWW round-trip strips it with no conflict and no warning
// (CLAUDE.md documents this trap prose-only for the per-question time limit).
// This script pins the mapping: for every kind, a MAXIMAL record (every field
// populated, including every optional) and a MINIMAL one (only required
// fields) are pushed through the real encode path (toPushX — real encryption,
// real AAD binding) and pulled back through the real decode path (pullEntries
// against a stubbed relay), then compared field by field.
//
// Run: pnpm --filter client exec tsx scripts/record-codec.ts
import assert from 'node:assert/strict';
import {
  toPushEntry,
  toPushTemplate,
  toPushInterviewType,
  toPushJournal,
  toPushAiSettings,
  pullEntries,
  type JournalEntry,
  type TemplateRecord,
  type InterviewType,
  type JournalRecord,
  type AiSettingsRecord,
  type MediaAttachment,
} from '../src/sync/engine';
import type { RelayClient, PushEntry } from '../src/sync/relay';
import { defaultAiSettings } from '../src/ai/types';

const dataKey = new Uint8Array(32).fill(7);

// A stub relay whose pull() hands back exactly the wire records we encoded —
// so decode runs through the real pullEntries path, decryption included.
function fakeRelay(records: PushEntry[]): RelayClient {
  return {
    pull: (_token: string, _since: number) =>
      Promise.resolve({
        entries: records.map((r) => ({ ...r })),
        cursor: records.length,
        more: false,
      }),
  } as unknown as RelayClient;
}

async function decodeAll(records: PushEntry[]) {
  return pullEntries(fakeRelay(records), 'token', dataKey, 0);
}

// ── fixtures: maximal (every field, every optional) + minimal ───────────────

const attachment: MediaAttachment = {
  id: 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8',
  kind: 'video',
  mime: 'video/webm',
  bytes: 123456,
  durationMs: 4200,
  name: 'clip.webm',
  width: 1280,
  height: 720,
  createdAt: 1_700_000_000_000,
  transcript: 'hello from the transcript',
};

const entryMax: JournalEntry = {
  id: 'e'.repeat(32),
  journalId: 'j-personal',
  title: 'A full entry',
  bodyText: 'body text with ünïcøde — 本文',
  bodyJson: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }),
  labels: ['travel', 'family'],
  attachments: [attachment],
  createdAt: 1_700_000_000_001,
  updatedAt: 1_700_000_000_002,
  deleted: false,
};
const entryMin: JournalEntry = {
  id: 'f'.repeat(32),
  journalId: 'j-tutorial',
  title: '',
  bodyText: '',
  labels: [],
  createdAt: 1,
  updatedAt: 2,
};
const entryTombstone: JournalEntry = { ...entryMin, id: '0'.repeat(32), deleted: true, updatedAt: 3 };

const templateMax: TemplateRecord = {
  id: '1'.repeat(32),
  name: 'Weekly review',
  bodyText: 'template body',
  bodyJson: JSON.stringify({ type: 'doc' }),
  builtin: 'weekly-review',
  createdAt: 10,
  updatedAt: 20,
  deleted: false,
};
const templateMin: TemplateRecord = {
  id: '2'.repeat(32),
  name: 'Bare',
  bodyText: '',
  createdAt: 11,
  updatedAt: 21,
};

const interviewMax: InterviewType = {
  id: '3'.repeat(32),
  name: 'Daily check-in',
  intro: 'One line intro',
  prompt: 'Ask about the day, one question at a time.',
  builtin: 'daily-checkin',
  createdAt: 30,
  updatedAt: 40,
  deleted: false,
};
const interviewMin: InterviewType = {
  id: '4'.repeat(32),
  name: 'Custom',
  intro: '',
  prompt: '',
  createdAt: 31,
  updatedAt: 41,
};

const journalMax: JournalRecord = {
  id: 'j-1755000000000-abc', // date-encoded id — rides INSIDE the ciphertext
  recordId: '5'.repeat(32),
  name: 'Field notes',
  subtitle: 'Lab work',
  color: '#6F7D4D',
  cover: 'grid',
  createdAt: 50,
  updatedAt: 60,
  deleted: false,
};

const aiMax: AiSettingsRecord = {
  recordId: '6'.repeat(32),
  settings: { ...defaultAiSettings(), enabled: true },
  updatedAt: 70,
};
const aiTombstone: AiSettingsRecord = {
  recordId: '7'.repeat(32),
  settings: null,
  updatedAt: 71,
  deleted: true,
};

// ── the round trip ──────────────────────────────────────────────────────────

const wire: PushEntry[] = [
  toPushEntry(dataKey, entryMax),
  toPushEntry(dataKey, entryMin),
  toPushEntry(dataKey, entryTombstone),
  toPushTemplate(dataKey, templateMax),
  toPushTemplate(dataKey, templateMin),
  toPushInterviewType(dataKey, interviewMax),
  toPushInterviewType(dataKey, interviewMin),
  toPushJournal(dataKey, journalMax),
  toPushAiSettings(dataKey, aiMax),
  toPushAiSettings(dataKey, aiTombstone),
];

// The cleartext oplog must never leak content fields.
for (const w of wire) {
  assert.equal(typeof w.entry_id, 'string');
  assert.equal(typeof w.lww_clock, 'number');
  assert.ok(!JSON.stringify({ ...w, ciphertext: '' }).includes('title'), 'no content in cleartext');
}
// Journal wire id is the random recordId, never the (leaky) journal id.
assert.equal(wire[7].entry_id, journalMax.recordId);
assert.ok(!wire.some((w) => w.entry_id.startsWith('j-')), 'journal ids stay inside the ciphertext');
// Journals without a wire id must refuse to encode, not leak or invent one.
assert.throws(() => toPushJournal(dataKey, { ...journalMax, recordId: undefined }));

const res = await decodeAll(wire);

// The counts route correctly by kind.
assert.equal(res.entries.length, 3);
assert.equal(res.templates.length, 2);
assert.equal(res.interviewTypes.length, 2);
assert.equal(res.journals.length, 1);
assert.equal(res.aiSettings.length, 2);

// Entries: every field survives; absent optionals stay absent (undefined).
const [e1, e2, e3] = res.entries;
assert.deepEqual(e1, { ...entryMax, deleted: false });
assert.deepEqual(e1.attachments?.[0], attachment); // incl. transcript/width/height/name
assert.deepEqual(e2, { ...entryMin, attachments: undefined, bodyJson: undefined, deleted: false });
assert.equal(e3.deleted, true);

// Templates: builtin survives (other devices retire their seed by it);
// pristine is local-only and must NOT come back from the wire.
const [t1, t2] = res.templates;
assert.deepEqual(t1, { ...templateMax, deleted: false });
assert.equal(t1.pristine, undefined);
assert.deepEqual(t2, { ...templateMin, bodyJson: undefined, builtin: undefined, deleted: false });

// Interview types: intro + prompt + builtin survive; pristine stays local.
const [i1, i2] = res.interviewTypes;
assert.deepEqual(i1, { ...interviewMax, deleted: false });
assert.equal(i1.pristine, undefined);
assert.deepEqual(i2, { ...interviewMin, builtin: undefined, deleted: false });

// Journals: the inner id pairs devices; the wire record id rides along.
assert.deepEqual(res.journals[0], { ...journalMax, deleted: false });

// AI settings: the whole settings object survives; a tombstone comes back as
// settings:null (the clearing must propagate).
const [ai1, ai2] = res.aiSettings;
assert.deepEqual(ai1, { ...aiMax, deleted: false });
assert.deepEqual(ai1.settings, aiMax.settings);
assert.equal(ai2.settings, null);
assert.equal(ai2.deleted, true);

// Tampering: a ciphertext served under a different record id must not decode
// (the M2 AAD binding) — pullEntries skips it rather than wedging.
const relabelled = { ...wire[0], entry_id: 'b'.repeat(32) };
const tampered = await decodeAll([relabelled]);
assert.equal(
  tampered.entries.length + tampered.templates.length + tampered.interviewTypes.length + tampered.journals.length + tampered.aiSettings.length,
  0,
  'a relabelled ciphertext must be dropped',
);

console.log('All record-codec field-mapping checks passed.');
