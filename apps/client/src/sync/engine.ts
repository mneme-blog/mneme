// Entry encryption + relay push/pull. The synced unit is a JournalEntry: its
// body is JSON-serialized, encrypted with the data key, and stored as an opaque
// blob. lww_clock = updatedAt (ms) — last-write-wins per entry (§3).
import { encrypt, decrypt } from '../crypto/aead';
import { utf8, fromUtf8 } from '../crypto/bytes';
import { toBase64, fromBase64 } from '../crypto/base64';
import type { PushEntry, RelayClient } from './relay';
import type { AiSettings } from '../ai/types';

// One media object attached to an entry. This metadata travels INSIDE the
// encrypted entry body — the relay sees only the random media id and the
// ciphertext chunk sizes, never mime/duration/size-of-plaintext (§3).
export interface MediaAttachment {
  id: string; // random 128-bit hex (newMediaId) — never date-encoded (§3)
  kind: 'video' | 'audio' | 'image' | 'file';
  mime: string;
  bytes: number; // plaintext size
  durationMs?: number;
  /** Original filename for uploads (recordings have none). */
  name?: string;
  /** Pixel size for images — lets layout reserve space before bytes resolve. */
  width?: number;
  height?: number;
  createdAt: number;
  /** Speech-to-text of a video/audio recording (ai/transcribe.ts). Rides in the
   *  node attrs inside the encrypted body — searchable, never seen by the relay. */
  transcript?: string;
}

export interface JournalEntry {
  id: string;
  journalId: string;
  title: string;
  bodyText: string;
  bodyJson?: string; // TipTap/ProseMirror document JSON (the rich source of truth)
  labels: string[];
  attachments?: MediaAttachment[];
  createdAt: number; // ms
  updatedAt: number; // ms — also the lww_clock
  deleted?: boolean;
}

// An entry template (§10 step 7, private only). Templates sync through the same
// oplog as entries: the record type lives INSIDE the ciphertext (`kind` below),
// so the relay cannot tell a template blob from an entry blob.
export interface TemplateRecord {
  id: string; // random 128-bit hex (newTemplateId) — never date-encoded (§3)
  name: string;
  bodyText: string;
  bodyJson?: string; // TipTap/ProseMirror document JSON
  /**
   * Built-in slug ('daily', 'gratitude', …) for templates that started life as a
   * predefined seed. Survives edits and tombstones so other devices can retire
   * their own untouched seed of the same built-in (they have different ids).
   */
  builtin?: string;
  /** Local-only: an untouched built-in seed. Never serialized; cleared on first edit. */
  pristine?: boolean;
  createdAt: number; // ms
  updatedAt: number; // ms — also the lww_clock
  deleted?: boolean;
}

// A guided-interview type (built-in or user-created). Syncs through the same oplog
// as entries and templates — the `kind` lives INSIDE the ciphertext, so the relay
// cannot tell an interview-type blob from an entry blob. Same builtin-slug + pristine
// semantics as TemplateRecord. The `prompt` is the question strategy the AI follows.
export interface InterviewType {
  id: string; // random 128-bit hex (newTemplateId) — never date-encoded (§3)
  name: string;
  /** One-line description shown in the picker. */
  intro: string;
  /** The question strategy that drives the interview (system-prompt fragment). */
  prompt: string;
  /** Built-in slug ('daily-checkin', …); survives edits/tombstones so other devices retire their seed. */
  builtin?: string;
  /** Local-only: an untouched built-in seed. Never serialized; cleared on first edit. */
  pristine?: boolean;
  createdAt: number; // ms
  updatedAt: number; // ms — also the lww_clock
  deleted?: boolean;
}

// A notebook, synced through the same oplog (`kind: 'journal'` inside the
// ciphertext — no server changes). Unlike templates, the wire record id is NOT
// the journal's id: builtin notebooks have well-known ids and user notebooks
// have timestamp-encoded ones, so `recordId` is a fresh random id and the real
// `id` (what entries reference in their encrypted bodies) travels inside the
// ciphertext. Cross-device identity therefore matches by `id`, no builtin-slug
// machinery needed — the builtin seeds share their fixed ids on every device.
export interface JournalRecord {
  /** The id entries reference (ciphertext-only — may be well-known or date-encoded). */
  id: string;
  /** Cleartext oplog id — always random (newRecordId), minted on first push. */
  recordId?: string;
  name: string;
  subtitle: string;
  color: string;
  cover: string;
  /** Local-only: an untouched sample seed. Never serialized; cleared on first edit. */
  pristine?: boolean;
  createdAt: number; // ms
  updatedAt: number; // ms — also the lww_clock
  deleted?: boolean;
}

// The AI-assistant settings as a synced singleton (`kind: 'aiSettings'` inside
// the ciphertext). Every device pushes under its own random record id; receivers
// keep whichever record carries the newest `updatedAt` and adopt the smallest
// record id they have seen so edits converge onto one record. `settings` is null
// on a tombstone (the user cleared the assistant configuration).
export interface AiSettingsRecord {
  recordId: string;
  settings: AiSettings | null;
  updatedAt: number; // ms — also the lww_clock
  deleted?: boolean;
}

// What actually gets encrypted (everything except the cleartext id/clock/deleted flag).
// `kind` is absent on entries (the original wire shape), 'template' on templates, and
// 'interviewType' on interview types; decoding routes on it, so pre-template blobs keep
// decoding as entries.
interface EntryBody {
  kind?: undefined;
  journalId: string;
  title: string;
  bodyText: string;
  bodyJson?: string;
  labels: string[];
  attachments?: MediaAttachment[];
  createdAt: number;
  updatedAt: number;
}

interface TemplateBody {
  kind: 'template';
  name: string;
  bodyText: string;
  bodyJson?: string;
  builtin?: string;
  createdAt: number;
  updatedAt: number;
}

interface InterviewTypeBody {
  kind: 'interviewType';
  name: string;
  intro: string;
  prompt: string;
  builtin?: string;
  createdAt: number;
  updatedAt: number;
}

interface JournalBody {
  kind: 'journal';
  journalId: string; // the id entries reference — kept off the cleartext oplog
  name: string;
  subtitle: string;
  color: string;
  cover: string;
  createdAt: number;
  updatedAt: number;
}

interface AiSettingsBody {
  kind: 'aiSettings';
  settings?: AiSettings; // absent on a tombstone
  updatedAt: number;
}

type RecordBody = EntryBody | TemplateBody | InterviewTypeBody | JournalBody | AiSettingsBody;

// ── binding a ciphertext to the record it belongs to ────────────────────────
//
// entry_id and lww_clock travel in cleartext and the AEAD tag does not cover
// them, so on its own the tag proves only "someone with the data key wrote
// this" — not "…wrote it for THIS record". A malicious or compromised relay
// could take the perfectly valid ciphertext of entry A, hand it back under
// entry B's id with a higher clock, and every device would decrypt it happily
// and overwrite B with A's content. The same move duplicates one entry across
// arbitrarily many ids and resurrects a tombstoned one under a new id.
//
// docs/SECURITY.md §6.7 accepts that a dumb relay can withhold or roll back a
// blob. Substituting one record's content for another's is a stronger move, is
// not what that section accepts, and costs one AAD to remove: the wire id is
// authenticated alongside the body, so a relabelled blob fails its tag.
const RECORD_AAD_PREFIX = 'mneme:record:v1:';

function recordAad(recordId: string): Uint8Array {
  return utf8(RECORD_AAD_PREFIX + recordId);
}

/** Encrypt a record body, bound to the wire id it will be stored under. */
function encryptRecord(dataKey: Uint8Array, recordId: string, body: RecordBody): Uint8Array {
  return encrypt(dataKey, utf8(JSON.stringify(body)), recordAad(recordId));
}

/**
 * Decrypt a pulled record.
 *
 * Blobs written before the binding existed carry no AAD, so they are tried
 * unbound as a fallback — those stay relabellable until they are next pushed,
 * which is why the client marks every record dirty once when it upgrades (db
 * migration v9). A blob written WITH the binding cannot be moved: the fallback
 * fails for it too, because its tag covers an id that is no longer the one it
 * arrived under.
 */
export function decryptRecord(dataKey: Uint8Array, recordId: string, blob: Uint8Array): Uint8Array {
  try {
    return decrypt(dataKey, blob, recordAad(recordId));
  } catch {
    return decrypt(dataKey, blob);
  }
}

// ── the per-kind codec table ────────────────────────────────────────────────
//
// One codec per record kind: how a record maps onto the wire (encode → the
// encrypted body; decode → the record from a pulled body). Encode and decode
// live side by side ON PURPOSE — they used to be five hand-written pusher
// functions and a mirror-image pull router 200 lines apart, which is exactly
// how a field gets added to one side and silently stripped by the other on the
// next LWW round-trip. The AssertNever checks below turn that field loss into
// a compile error.

interface Codec<R, B extends RecordBody> {
  /** The cleartext oplog id this record is stored under (throws if absent). */
  wireId(rec: R): string;
  deleted(rec: R): boolean;
  /** Project the record into its encrypted wire body. */
  encode(rec: R): B;
  /** Rebuild the record from a pulled body (+ the cleartext id/tombstone flag). */
  decode(wireId: string, body: B, deleted: boolean): R;
}

// Compile-time completeness guard: the encrypted body must carry every record
// field except the ones deliberately excluded (cleartext wire fields and
// local-only flags), and no field the record doesn't have. Add a field to a
// record type without adding it to its body — or vice versa — and the matching
// AssertNever below stops compiling. This is the guard against the silent
// LWW field loss CLAUDE.md could previously only warn about in prose.
type AssertNever<T extends never> = T;

type _EntryFieldsAllCarried = AssertNever<Exclude<keyof Omit<JournalEntry, 'id' | 'deleted'>, keyof EntryBody>>;
type _EntryBodyNoOrphans = AssertNever<Exclude<keyof Omit<EntryBody, 'kind'>, keyof JournalEntry>>;
type _TemplateFieldsAllCarried = AssertNever<Exclude<keyof Omit<TemplateRecord, 'id' | 'deleted' | 'pristine'>, keyof TemplateBody>>;
type _TemplateBodyNoOrphans = AssertNever<Exclude<keyof Omit<TemplateBody, 'kind'>, keyof TemplateRecord>>;
type _InterviewFieldsAllCarried = AssertNever<Exclude<keyof Omit<InterviewType, 'id' | 'deleted' | 'pristine'>, keyof InterviewTypeBody>>;
type _InterviewBodyNoOrphans = AssertNever<Exclude<keyof Omit<InterviewTypeBody, 'kind'>, keyof InterviewType>>;
type _JournalFieldsAllCarried = AssertNever<Exclude<keyof Omit<JournalRecord, 'id' | 'recordId' | 'deleted' | 'pristine'>, keyof JournalBody>>;
type _JournalBodyNoOrphans = AssertNever<Exclude<keyof Omit<JournalBody, 'kind' | 'journalId'>, keyof JournalRecord>>;
// (AiSettingsBody is checked structurally by its codec: `settings` is the whole
// object, so there is no field-by-field projection to drift.)
export type _CodecCompletenessChecks = [
  _EntryFieldsAllCarried,
  _EntryBodyNoOrphans,
  _TemplateFieldsAllCarried,
  _TemplateBodyNoOrphans,
  _InterviewFieldsAllCarried,
  _InterviewBodyNoOrphans,
  _JournalFieldsAllCarried,
  _JournalBodyNoOrphans,
];

const entryCodec: Codec<JournalEntry, EntryBody> = {
  wireId: (e) => e.id,
  deleted: (e) => e.deleted ?? false,
  encode: (e) => ({
    journalId: e.journalId,
    title: e.title,
    bodyText: e.bodyText,
    bodyJson: e.bodyJson,
    labels: e.labels,
    attachments: e.attachments,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  }),
  decode: (wireId, body, deleted) => ({
    id: wireId,
    journalId: body.journalId,
    title: body.title,
    bodyText: body.bodyText,
    bodyJson: body.bodyJson,
    labels: body.labels ?? [],
    attachments: body.attachments,
    createdAt: body.createdAt,
    updatedAt: body.updatedAt,
    deleted,
  }),
};

const templateCodec: Codec<TemplateRecord, TemplateBody> = {
  wireId: (t) => t.id,
  deleted: (t) => t.deleted ?? false,
  encode: (t) => ({
    kind: 'template',
    name: t.name,
    bodyText: t.bodyText,
    bodyJson: t.bodyJson,
    builtin: t.builtin,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }),
  decode: (wireId, body, deleted) => ({
    id: wireId,
    name: body.name,
    bodyText: body.bodyText,
    bodyJson: body.bodyJson,
    builtin: body.builtin,
    createdAt: body.createdAt,
    updatedAt: body.updatedAt,
    deleted,
  }),
};

const interviewTypeCodec: Codec<InterviewType, InterviewTypeBody> = {
  wireId: (t) => t.id,
  deleted: (t) => t.deleted ?? false,
  encode: (t) => ({
    kind: 'interviewType',
    name: t.name,
    intro: t.intro,
    prompt: t.prompt,
    builtin: t.builtin,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }),
  decode: (wireId, body, deleted) => ({
    id: wireId,
    name: body.name,
    intro: body.intro,
    prompt: body.prompt,
    builtin: body.builtin,
    createdAt: body.createdAt,
    updatedAt: body.updatedAt,
    deleted,
  }),
};

const journalCodec: Codec<JournalRecord, JournalBody> = {
  wireId: (j) => {
    if (!j.recordId) throw new Error('journal record has no wire id');
    return j.recordId;
  },
  deleted: (j) => j.deleted ?? false,
  encode: (j) => ({
    kind: 'journal',
    journalId: j.id, // the leaky id stays inside the ciphertext (§3)
    name: j.name,
    subtitle: j.subtitle,
    color: j.color,
    cover: j.cover,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  }),
  decode: (wireId, body, deleted) => ({
    id: body.journalId,
    recordId: wireId,
    name: body.name,
    subtitle: body.subtitle,
    color: body.color,
    cover: body.cover,
    createdAt: body.createdAt,
    updatedAt: body.updatedAt,
    deleted,
  }),
};

const aiSettingsCodec: Codec<AiSettingsRecord, AiSettingsBody> = {
  wireId: (r) => r.recordId,
  deleted: (r) => r.deleted ?? r.settings === null,
  encode: (r) => ({
    kind: 'aiSettings',
    settings: r.settings ?? undefined,
    updatedAt: r.updatedAt,
  }),
  decode: (wireId, body, deleted) => ({
    recordId: wireId,
    settings: deleted ? null : (body.settings ?? null),
    updatedAt: body.updatedAt,
    deleted,
  }),
};

function toPush<R, B extends RecordBody>(codec: Codec<R, B>, dataKey: Uint8Array, rec: R): PushEntry {
  const id = codec.wireId(rec);
  const body = codec.encode(rec);
  return {
    entry_id: id,
    // Every kind uses updatedAt as its clock; read it from the body so the
    // clock can never disagree with what was encrypted.
    lww_clock: body.updatedAt,
    ciphertext: toBase64(encryptRecord(dataKey, id, body)),
    deleted: codec.deleted(rec),
  };
}

export function encryptEntry(dataKey: Uint8Array, e: JournalEntry): Uint8Array {
  return encryptRecord(dataKey, e.id, entryCodec.encode(e));
}

export function toPushEntry(dataKey: Uint8Array, e: JournalEntry): PushEntry {
  return toPush(entryCodec, dataKey, e);
}

/**
 * The relay caps one push at 500 records (docs/API.md; server maxPushEntries),
 * so every push path chunks here rather than each caller remembering to. The
 * outbox flush pushes its whole pending set, a Day One import can queue
 * thousands at once, and phrase rotation re-pushes an entire vault — all of
 * which would otherwise 413 on a large journal.
 *
 * Chunks are sequential on purpose: a partial failure must leave the un-pushed
 * remainder dirty in the outbox, and the caller retires exactly the ids that
 * came back acknowledged.
 */
const PUSH_LIMIT = 500;

async function pushInChunks(
  relay: RelayClient,
  token: string,
  records: PushEntry[],
): Promise<Set<string>> {
  const acked = new Set<string>();
  for (let i = 0; i < records.length; i += PUSH_LIMIT) {
    const resp = await relay.push(token, records.slice(i, i + PUSH_LIMIT));
    for (const r of resp.results) acked.add(r.entry_id);
  }
  return acked;
}

/**
 * Push entries; returns the set of entry ids the relay acknowledged. An
 * acknowledgment is any per-record result — applied, or rejected because the
 * stored lww_clock is already >= ours (a retry after a lost ack, or a newer
 * copy from another device). Both settle the record: the relay durably holds
 * this version or newer, so the outbox must retire it and let the pull path
 * reconcile. Retiring only `applied` ids wedged the outbox forever on an
 * equal-clock retry.
 */
export async function pushEntries(
  relay: RelayClient,
  token: string,
  dataKey: Uint8Array,
  entries: JournalEntry[],
): Promise<Set<string>> {
  if (entries.length === 0) return new Set();
  return pushInChunks(relay, token, entries.map((e) => toPush(entryCodec, dataKey, e)));
}

export function toPushTemplate(dataKey: Uint8Array, t: TemplateRecord): PushEntry {
  return toPush(templateCodec, dataKey, t);
}

/** Push templates through the same oplog; returns the acknowledged template ids (see pushEntries). */
export async function pushTemplates(
  relay: RelayClient,
  token: string,
  dataKey: Uint8Array,
  templates: TemplateRecord[],
): Promise<Set<string>> {
  if (templates.length === 0) return new Set();
  return pushInChunks(relay, token, templates.map((t) => toPush(templateCodec, dataKey, t)));
}

export function toPushInterviewType(dataKey: Uint8Array, t: InterviewType): PushEntry {
  return toPush(interviewTypeCodec, dataKey, t);
}

/** Push interview types through the same oplog; returns the acknowledged ids (see pushEntries). */
export async function pushInterviewTypes(
  relay: RelayClient,
  token: string,
  dataKey: Uint8Array,
  types: InterviewType[],
): Promise<Set<string>> {
  if (types.length === 0) return new Set();
  return pushInChunks(relay, token, types.map((t) => toPush(interviewTypeCodec, dataKey, t)));
}

export function toPushJournal(dataKey: Uint8Array, j: JournalRecord): PushEntry {
  return toPush(journalCodec, dataKey, j);
}

/** Push journals through the same oplog; returns the acknowledged RECORD ids, not journal ids (see pushEntries). */
export async function pushJournals(
  relay: RelayClient,
  token: string,
  dataKey: Uint8Array,
  journals: JournalRecord[],
): Promise<Set<string>> {
  if (journals.length === 0) return new Set();
  return pushInChunks(relay, token, journals.map((j) => toPush(journalCodec, dataKey, j)));
}

export function toPushAiSettings(dataKey: Uint8Array, rec: AiSettingsRecord): PushEntry {
  return toPush(aiSettingsCodec, dataKey, rec);
}

/**
 * Push the AI-settings singleton. Like the sibling pushers, any per-record
 * answer settles the record — applied, or rejected because the relay already
 * holds this clock or newer (the next pull brings the newer copy here). The
 * caller retires the queued record either way, so there is nothing to return.
 */
export async function pushAiSettings(
  relay: RelayClient,
  token: string,
  dataKey: Uint8Array,
  rec: AiSettingsRecord,
): Promise<void> {
  await relay.push(token, [toPushAiSettings(dataKey, rec)]);
}

export interface PullResult {
  entries: JournalEntry[];
  templates: TemplateRecord[];
  interviewTypes: InterviewType[];
  journals: JournalRecord[];
  aiSettings: AiSettingsRecord[];
  cursor: number;
  more: boolean;
}

/** Pull changes since the cursor, decrypt, and route each record by its kind. */
export async function pullEntries(
  relay: RelayClient,
  token: string,
  dataKey: Uint8Array,
  since: number,
): Promise<PullResult> {
  const resp = await relay.pull(token, since);
  const entries: JournalEntry[] = [];
  const templates: TemplateRecord[] = [];
  const interviewTypes: InterviewType[] = [];
  const journals: JournalRecord[] = [];
  const aiSettings: AiSettingsRecord[] = [];
  for (const item of resp.entries) {
    let body: RecordBody;
    try {
      body = JSON.parse(
        fromUtf8(decryptRecord(dataKey, item.entry_id, fromBase64(item.ciphertext))),
      ) as RecordBody;
    } catch {
      // A record that will not open — tampered with, relabelled, or written by
      // a build we don't understand. Skip it and keep going: throwing here
      // wedges the whole vault's sync on one bad record, from this cursor
      // onwards, forever. The local DB is the source of truth (§5a), so
      // dropping a record we cannot authenticate loses nothing we had.
      console.warn(`sync: skipping record ${item.entry_id} — it did not decrypt`);
      continue;
    }
    // Route by the kind inside the ciphertext to the codec that wrote it —
    // pre-template blobs carry no kind and decode as entries, the original
    // wire shape.
    if (body.kind === 'template') {
      templates.push(templateCodec.decode(item.entry_id, body, item.deleted));
    } else if (body.kind === 'interviewType') {
      interviewTypes.push(interviewTypeCodec.decode(item.entry_id, body, item.deleted));
    } else if (body.kind === 'journal') {
      journals.push(journalCodec.decode(item.entry_id, body, item.deleted));
    } else if (body.kind === 'aiSettings') {
      aiSettings.push(aiSettingsCodec.decode(item.entry_id, body, item.deleted));
    } else {
      entries.push(entryCodec.decode(item.entry_id, body, item.deleted));
    }
  }
  return { entries, templates, interviewTypes, journals, aiSettings, cursor: resp.cursor, more: resp.more };
}
