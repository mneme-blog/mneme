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

export function encryptEntry(dataKey: Uint8Array, e: JournalEntry): Uint8Array {
  const body: EntryBody = {
    journalId: e.journalId,
    title: e.title,
    bodyText: e.bodyText,
    bodyJson: e.bodyJson,
    labels: e.labels,
    attachments: e.attachments,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
  return encrypt(dataKey, utf8(JSON.stringify(body)));
}

export function toPushEntry(dataKey: Uint8Array, e: JournalEntry): PushEntry {
  return {
    entry_id: e.id,
    lww_clock: e.updatedAt,
    ciphertext: toBase64(encryptEntry(dataKey, e)),
    deleted: e.deleted ?? false,
  };
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
  return pushInChunks(relay, token, entries.map((e) => toPushEntry(dataKey, e)));
}

export function toPushTemplate(dataKey: Uint8Array, t: TemplateRecord): PushEntry {
  const body: TemplateBody = {
    kind: 'template',
    name: t.name,
    bodyText: t.bodyText,
    bodyJson: t.bodyJson,
    builtin: t.builtin,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
  return {
    entry_id: t.id,
    lww_clock: t.updatedAt,
    ciphertext: toBase64(encrypt(dataKey, utf8(JSON.stringify(body)))),
    deleted: t.deleted ?? false,
  };
}

/** Push templates through the same oplog; returns the acknowledged template ids (see pushEntries). */
export async function pushTemplates(
  relay: RelayClient,
  token: string,
  dataKey: Uint8Array,
  templates: TemplateRecord[],
): Promise<Set<string>> {
  if (templates.length === 0) return new Set();
  return pushInChunks(relay, token, templates.map((t) => toPushTemplate(dataKey, t)));
}

export function toPushInterviewType(dataKey: Uint8Array, t: InterviewType): PushEntry {
  const body: InterviewTypeBody = {
    kind: 'interviewType',
    name: t.name,
    intro: t.intro,
    prompt: t.prompt,
    builtin: t.builtin,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
  return {
    entry_id: t.id,
    lww_clock: t.updatedAt,
    ciphertext: toBase64(encrypt(dataKey, utf8(JSON.stringify(body)))),
    deleted: t.deleted ?? false,
  };
}

/** Push interview types through the same oplog; returns the acknowledged ids (see pushEntries). */
export async function pushInterviewTypes(
  relay: RelayClient,
  token: string,
  dataKey: Uint8Array,
  types: InterviewType[],
): Promise<Set<string>> {
  if (types.length === 0) return new Set();
  return pushInChunks(relay, token, types.map((t) => toPushInterviewType(dataKey, t)));
}

export function toPushJournal(dataKey: Uint8Array, j: JournalRecord): PushEntry {
  if (!j.recordId) throw new Error('journal record has no wire id');
  const body: JournalBody = {
    kind: 'journal',
    journalId: j.id,
    name: j.name,
    subtitle: j.subtitle,
    color: j.color,
    cover: j.cover,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  };
  return {
    entry_id: j.recordId,
    lww_clock: j.updatedAt,
    ciphertext: toBase64(encrypt(dataKey, utf8(JSON.stringify(body)))),
    deleted: j.deleted ?? false,
  };
}

/** Push journals through the same oplog; returns the acknowledged RECORD ids, not journal ids (see pushEntries). */
export async function pushJournals(
  relay: RelayClient,
  token: string,
  dataKey: Uint8Array,
  journals: JournalRecord[],
): Promise<Set<string>> {
  if (journals.length === 0) return new Set();
  return pushInChunks(relay, token, journals.map((j) => toPushJournal(dataKey, j)));
}

export function toPushAiSettings(dataKey: Uint8Array, rec: AiSettingsRecord): PushEntry {
  const body: AiSettingsBody = {
    kind: 'aiSettings',
    settings: rec.settings ?? undefined,
    updatedAt: rec.updatedAt,
  };
  return {
    entry_id: rec.recordId,
    lww_clock: rec.updatedAt,
    ciphertext: toBase64(encrypt(dataKey, utf8(JSON.stringify(body)))),
    deleted: rec.deleted ?? rec.settings === null,
  };
}

/** Push the AI-settings singleton; returns true when the relay accepted it. */
export async function pushAiSettings(
  relay: RelayClient,
  token: string,
  dataKey: Uint8Array,
  rec: AiSettingsRecord,
): Promise<boolean> {
  const resp = await relay.push(token, [toPushAiSettings(dataKey, rec)]);
  return resp.results.some((r) => r.applied && r.entry_id === rec.recordId);
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
    const body = JSON.parse(fromUtf8(decrypt(dataKey, fromBase64(item.ciphertext)))) as RecordBody;
    if (body.kind === 'template') {
      templates.push({
        id: item.entry_id,
        name: body.name,
        bodyText: body.bodyText,
        bodyJson: body.bodyJson,
        builtin: body.builtin,
        createdAt: body.createdAt,
        updatedAt: body.updatedAt,
        deleted: item.deleted,
      });
    } else if (body.kind === 'interviewType') {
      interviewTypes.push({
        id: item.entry_id,
        name: body.name,
        intro: body.intro,
        prompt: body.prompt,
        builtin: body.builtin,
        createdAt: body.createdAt,
        updatedAt: body.updatedAt,
        deleted: item.deleted,
      });
    } else if (body.kind === 'journal') {
      journals.push({
        id: body.journalId,
        recordId: item.entry_id,
        name: body.name,
        subtitle: body.subtitle,
        color: body.color,
        cover: body.cover,
        createdAt: body.createdAt,
        updatedAt: body.updatedAt,
        deleted: item.deleted,
      });
    } else if (body.kind === 'aiSettings') {
      aiSettings.push({
        recordId: item.entry_id,
        settings: item.deleted ? null : (body.settings ?? null),
        updatedAt: body.updatedAt,
        deleted: item.deleted,
      });
    } else {
      entries.push({
        id: item.entry_id,
        journalId: body.journalId,
        title: body.title,
        bodyText: body.bodyText,
        bodyJson: body.bodyJson,
        labels: body.labels ?? [],
        attachments: body.attachments,
        createdAt: body.createdAt,
        updatedAt: body.updatedAt,
        deleted: item.deleted,
      });
    }
  }
  return { entries, templates, interviewTypes, journals, aiSettings, cursor: resp.cursor, more: resp.more };
}
