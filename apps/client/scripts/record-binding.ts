// Regression check for the record→id binding (audit finding M2).
//
// entry_id and lww_clock travel in cleartext and the AEAD tag never covered
// them, so the tag proved "someone with the data key wrote this" and nothing
// about WHICH record it was written for. A malicious relay could hand back
// entry A's ciphertext under entry B's id with a higher clock, and every device
// would decrypt it happily and overwrite B with A's content — silently, with no
// integrity error. The record body is now encrypted with the wire id as AAD.
//
// Asserts: a bound blob opens under its own id and nowhere else, a legacy
// (unbound) blob still opens, and a pull survives a record it cannot decrypt
// instead of wedging the vault's sync on it.
//
// Run: pnpm --filter client exec tsx scripts/record-binding.ts
import { encrypt } from '../src/crypto/aead';
import { utf8 } from '../src/crypto/bytes';
import { toBase64 } from '../src/crypto/base64';
import {
  decryptRecord,
  encryptEntry,
  pullEntries,
  toPushAiSettings,
  toPushJournal,
  toPushTemplate,
  type JournalEntry,
} from '../src/sync/engine';
import type { RelayClient } from '../src/sync/relay';

let failures = 0;
function check(label: string, ok: boolean): void {
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${label}`);
  } else {
    console.log(`  ok    ${label}`);
  }
}

function threw(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const dataKey = new Uint8Array(32).fill(7);

const entry: JournalEntry = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  journalId: 'j-personal',
  title: 'A day',
  bodyText: 'the quiet kind',
  labels: [],
  createdAt: 1,
  updatedAt: 2,
};

// ── 1. a bound blob opens under its own id, and only under its own id ────────
const blob = encryptEntry(dataKey, entry);
check(
  'a record decrypts under the id it was written for',
  JSON.parse(new TextDecoder().decode(decryptRecord(dataKey, entry.id, blob))).title === 'A day',
);
check(
  'the same blob served under another id is rejected',
  threw(() => decryptRecord(dataKey, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', blob)),
);
check(
  'and it is rejected with no id at all (the old unbound form)',
  threw(() => decryptRecord(dataKey, '', blob)),
);

// ── 2. every record kind is bound, not just entries ──────────────────────────
const kinds: [string, string, string][] = [
  (() => {
    const p = toPushTemplate(dataKey, {
      id: 'tpl-1', name: 'T', bodyText: '', createdAt: 1, updatedAt: 1,
    });
    return ['template', p.entry_id, p.ciphertext];
  })(),
  (() => {
    const p = toPushJournal(dataKey, {
      id: 'j-personal', recordId: 'rec-1', name: 'N', subtitle: '', color: '', cover: '',
      createdAt: 1, updatedAt: 1,
    });
    return ['journal', p.entry_id, p.ciphertext];
  })(),
  (() => {
    const p = toPushAiSettings(dataKey, { recordId: 'rec-2', settings: null, updatedAt: 1 });
    return ['aiSettings', p.entry_id, p.ciphertext];
  })(),
];
for (const [kind, id, ciphertext] of kinds) {
  const bytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  check(`${kind} records open under their own wire id`, !threw(() => decryptRecord(dataKey, id, bytes)));
  check(`${kind} records are rejected when relabelled`, threw(() => decryptRecord(dataKey, id + 'x', bytes)));
}

// ── 3. blobs written before the binding still open ───────────────────────────
// They stay relabellable — nothing can change that for a blob already on the
// relay — which is why db migration v9 re-pushes every record once.
const legacy = encrypt(dataKey, utf8(JSON.stringify({ kind: 'template', name: 'old', bodyText: '', createdAt: 1, updatedAt: 1 })));
check(
  'a pre-binding blob still decrypts (fallback)',
  JSON.parse(new TextDecoder().decode(decryptRecord(dataKey, 'tpl-old', legacy))).name === 'old',
);

// ── 4. one poisoned record must not wedge the whole pull ─────────────────────
// Throwing here would leave sync permanently stuck: every later pull starts from
// the same cursor and hits the same record again.
const relayStub = {
  pull: async () => ({
    entries: [
      { entry_id: 'relabelled', lww_clock: 9, ciphertext: toBase64(blob), deleted: false, seq: 1 },
      { entry_id: entry.id, lww_clock: 2, ciphertext: toBase64(blob), deleted: false, seq: 2 },
    ],
    cursor: 2,
    more: false,
  }),
} as unknown as RelayClient;

const pulled = await pullEntries(relayStub, 'token', dataKey, 0);
check('a relabelled record is skipped, not fatal', pulled.entries.length === 1);
check('the honest record in the same batch still arrives', pulled.entries[0]?.id === entry.id);
check('the cursor still advances past the skipped record', pulled.cursor === 2);

console.log(failures === 0 ? '\nrecord binding: OK' : `\nrecord binding: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
