// AppData provider: holds the in-memory identity/session, the live entry list,
// and the background sync loop. Seed/identity live in memory; at rest the seed
// is either nowhere (re-enter the mnemonic on cold start — the default) or, if
// the user opted in, sealed in IndexedDB under an Argon2id passphrase or a
// WebAuthn PRF security key (§6). Entry bodies are encrypted before they reach
// the relay either way.
import type { ComponentChildren, VNode } from 'preact';
import { createContext } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { RelayClient, RelayError, resolveRelayUrl, buildDefaultRelayUrl, setStoredRelayUrl } from '../sync/relay';
import { authenticate, PendingApprovalError, type Session } from '../sync/identity';
import { deriveIdentity, type Identity } from '../crypto/keys';
import { mnemonicToSeed } from '../crypto/mnemonic';
import { sealSeed, sealSeedWithPrfSecret, sealWithKey, openSeed, openSeedWithPrfSecret, type WrapKey } from '../crypto/seedlock';
import { enrollPrfCredential, evalPrf } from '../platform/webauthn';
import { loadSealedSeed, storeSealedSeed, clearSealedSeed, loadAiSettingsRecord, storeAiSettingsRecord, clearAiSettingsRecord } from '../platform/keystore';
import { sealAiSettings, openAiSettings, type AiSyncMeta } from '../ai/settings';
import type { AiSettings } from '../ai/types';
import { pushEntries, pushTemplates, pushInterviewTypes, pushJournals, pushAiSettings, pullEntries, type JournalEntry, type MediaAttachment, type TemplateRecord, type InterviewType, type JournalRecord, type AiSettingsRecord } from '../sync/engine';
import { uploadMedia, downloadMedia } from '../sync/media';
import { rotateAccount, type RotationProgress } from '../sync/rotate';
import { newEntryId, newMediaId, newTemplateId, newRecordId } from '../sync/ids';
import { ENTRIES, JOURNALS, type Journal, type CoverPattern } from '../data/sample';
import { seedBuiltinTemplates, localizeBuiltinTemplate } from '../data/templates';
import { seedBuiltinInterviews, localizeBuiltinInterview } from '../data/interviews';
import type { JSONContent } from '@tiptap/core';
import { blocksToDoc, textToDoc, docToText, docMediaIds } from '../editor/doc';
import { setFilmAttr, setTranscriptAttr } from '../editor/videointerviewData';
import { stopAllRenders } from '../video/film';
import { LocalDb, destroyOwnerDb, type MediaRecord } from '../db';
import { makeThumbnail } from '../ui/thumbnail';
import { t, tp, fmtDate, useI18n } from '../i18n';

export type SyncStatus = 'locked' | 'connecting' | 'online' | 'offline';

/** How the seed gets sealed at rest when the user opts into staying signed in. */
export type SealChoice = { method: 'passphrase'; passphrase: string } | { method: 'securityKey' };
export type DeviceUnlockChoice = SealChoice | { method: 'off' };

interface AppData {
  status: SyncStatus;
  // Whether a sealed seed exists on this device: true → the lock screen offers
  // an unlock path; null → the keystore check hasn't resolved yet (don't render
  // onboarding until it has, or the unlock view flashes).
  hasVault: boolean | null;
  // Which factor seals the seed on this device — drives the unlock view and the
  // Preferences "Device unlock" row. null while unresolved or when no seal exists.
  vaultMethod: 'passphrase' | 'securityKey' | null;
  /**
   * The vault's current relay session token, or null when not signed in.
   *
   * A getter, not a value: the session lives in a ref and is replaced on
   * re-authentication, so anything that captured a token at render time would
   * go stale. Narrow on purpose — it exists for the transcription gate
   * (ai/transcribe.ts), where the relay authorizes a request whose audio it
   * must never see, and it is attached only to the bundled same-origin
   * endpoint. Nothing else should reach for this.
   */
  transcribeToken: () => string | null;
  // The vault's opaque owner id while unlocked (base64url(sha256(ownerPub)) —
  // already cleartext on the relay, so showing it leaks nothing). Its first 8
  // chars match the truncated vault label in the operator admin dashboard.
  ownerId: string | null;
  // True when the relay accepted this device but the operator has not yet approved
  // the vault (a relay running REQUIRE_APPROVAL). The identity is valid and held;
  // the app shows a blocking "pending approval" screen instead of the timeline.
  pendingApproval: boolean;
  // The vault's memorable, non-secret operator hint (e.g. "amber-otter-07"),
  // derived from the seed — shown on the pending screen so the user can quote it
  // to the operator. null while locked.
  approvalHint: string | null;
  /** Retry authentication from the pending screen (after the operator approves). */
  retryApproval(): void;
  // How many local entries still wait to be pushed to the relay (the outbox depth).
  pendingCount: number;
  // Notebook ids that still have entries waiting in the push outbox — drives the
  // per-journal "Syncing…" badge so a bulk import shows which notebooks are still
  // catching up. Media-only tails are reflected in `pendingCount`, not here.
  pendingJournalIds: Set<string>;
  // High-water mark of the outbox since it was last empty — the denominator for a
  // sync progress bar (records done = syncTotal − pendingCount). Resets to 0 the
  // moment everything is flushed, so the bar shows up only during an active run.
  syncTotal: number;
  // True while a push to the relay is in flight.
  saving: boolean;
  // True from sign-in until the first sync attempt finishes (pull done or
  // offline). While set, an empty timeline means "still arriving" — screens
  // show a syncing notice instead of an empty state.
  bootstrapping: boolean;
  entries: JournalEntry[];
  journals: Journal[];
  // Entry templates — built-in seeds and user-created records alike, tombstones
  // included (callers filter on `deleted`).
  templates: TemplateRecord[];
  // Guided-interview types — built-in seeds and user-created records alike,
  // tombstones included (callers filter on `deleted`). Sync like templates.
  interviewTypes: InterviewType[];
  // AI assistant configuration (client-only feature; the relay is never involved).
  // null while locked or when the feature was never set up — every AI surface
  // hides itself in that case. Decrypted from its sealed IndexedDB record on
  // unlock; the seal key derives from the vault seed.
  aiSettings: AiSettings | null;
  /** Persist (sealed) and apply new AI settings; null disables and clears the record. */
  saveAiSettings(s: AiSettings | null): Promise<void>;
  /**
   * Enter with the recovery phrase. With a `seal` choice, the derived seed is
   * additionally sealed into IndexedDB — under an Argon2id passphrase or a
   * WebAuthn PRF secret (the security-key ceremony runs first; a cancelled one
   * rejects before any state changes) — so later cold starts can unlock with
   * that factor. Without it, any previously stored seal is removed and nothing
   * about the identity touches disk.
   */
  signIn(mnemonic: string, seal?: SealChoice): Promise<void>;
  /** Cold-start path when a passphrase-sealed seed exists. Rejects on a wrong passphrase. */
  unlock(passphrase: string): Promise<void>;
  /** Cold-start path when a security-key-sealed seed exists. Runs the WebAuthn
   * ceremony; rejects on cancel, an absent key, or the wrong key. */
  unlockWithKey(): Promise<void>;
  /**
   * Switch the at-rest seal while unlocked (Preferences → Vault): enroll a
   * security key, set a passphrase, or turn persistence off. The previous seal
   * is only replaced after the new one succeeds.
   */
  setDeviceUnlock(choice: DeviceUnlockChoice): Promise<void>;
  /** Drop the in-memory identity and return to the lock screen. */
  lock(): void;
  createEntry(input: { journalId: string; title?: string; bodyText?: string; bodyJson?: string; labels?: string[] }): JournalEntry;
  updateEntry(id: string, patch: { journalId?: string; title?: string; bodyText?: string; bodyJson?: string; labels?: string[]; createdAt?: number; attachments?: MediaAttachment[] }): void;
  /**
   * Write a rendered film into the video-interview node with this session id.
   * A no-op if the entry or the node is gone (the user deleted it while the
   * render was running).
   */
  attachFilm(entryId: string, sessionId: string, film: MediaAttachment): void;
  /**
   * Write one answer's transcript into the video-interview node with this
   * session id (auto-transcribe after save — the sheet that started it is
   * gone by the time results land). A no-op if the entry or node is gone.
   */
  attachTranscript(entryId: string, sessionId: string, cardIndex: number, transcript: string): void;
  /**
   * After the user confirmed: tombstone the entry (the deletion syncs to other
   * devices through the LWW oplog) and delete every recording it references —
   * locally and on the relay.
   */
  deleteEntry(id: string): void;
  newJournal(j: Journal): void;
  /**
   * Restyle an existing notebook — rename it and/or change its colour or cover.
   * Journals sync as encrypted `kind:'journal'` records through the LWW oplog
   * (the journal id itself never appears in cleartext — §3), so the change
   * reaches the vault's other devices. `count`/`last` are derived and ignored.
   */
  updateJournal(id: string, patch: { name?: string; subtitle?: string; color?: string; cover?: CoverPattern }): void;
  /**
   * After the user typed "delete": tombstone the notebook and every entry in it
   * (both sync to other devices through the LWW oplog, and the entries'
   * recordings are purged locally and on the relay).
   */
  deleteJournal(id: string): void;
  createTemplate(input: { name: string; bodyText?: string; bodyJson?: string }): TemplateRecord;
  updateTemplate(id: string, patch: { name?: string; bodyText?: string; bodyJson?: string }): void;
  /** Tombstones the template (built-ins included) so the deletion reaches other devices. */
  deleteTemplate(id: string): void;
  createInterviewType(input: { name: string; intro?: string; prompt?: string }): InterviewType;
  updateInterviewType(id: string, patch: { name?: string; intro?: string; prompt?: string }): void;
  /** Tombstones the interview type (built-ins included) so the deletion reaches other devices. */
  deleteInterviewType(id: string): void;
  /**
   * Persist a freshly-recorded clip or uploaded file locally and queue its
   * background upload. Returns the attachment metadata for the caller to embed
   * in the entry document (the editor inserts it as an inline node in bodyJson).
   */
  addMedia(
    entryId: string,
    kind: MediaAttachment['kind'],
    blob: Blob,
    meta?: { durationMs?: number; name?: string; width?: number; height?: number },
  ): Promise<MediaAttachment | null>;
  /**
   * After the user confirmed deleting a recording: purge its local bytes +
   * upload-queue slot and delete it from the relay (queued durably if offline).
   */
  removeMedia(mediaId: string): void;
  /** Resolve an attachment to playable bytes: local DB first, then relay download. */
  mediaBlob(entryId: string, att: MediaAttachment): Promise<Blob | null>;
  /**
   * Resolve a small thumbnail for an image attachment (the overview lists). Served
   * from the cached downscaled JPEG when present; otherwise generated once from the
   * full bytes and persisted. Returns null for non-images or when bytes are unreachable.
   */
  mediaThumb(entryId: string, att: MediaAttachment): Promise<Blob | null>;
  /**
   * Replace the recovery phrase: re-encrypt the vault under `newMnemonic` (a new
   * owner), wipe the old account from the relay, and re-home local state. Throws
   * (with the old account fully intact) if anything fails before the wipe.
   */
  rotatePhrase(newMnemonic: string, onProgress?: (p: RotationProgress) => void): Promise<void>;
  /**
   * Permanently delete the vault. Wipes the account from the relay (entries,
   * media, reminders, devices, sessions — the §5b cascade), then erases this
   * device: the plaintext OPFS DB and any at-rest seal. Ends back at onboarding.
   * Other devices keep their local copies but stop syncing; the same phrase
   * re-registers as an empty vault (TOFU). Throws — with everything intact —
   * when the relay can't be reached: deleting needs an explicit online "yes",
   * never an offline queue.
   */
  deleteVault(): Promise<void>;
  /** The relay base URL currently in effect (a user override, else the build default). */
  relayUrl: string;
  /**
   * Point the app at a different relay (self-hosters), or pass null to fall back
   * to the build-time default. Persisted across restarts; re-creates the relay
   * client, and a signed-in session drops its old token and re-authenticates
   * (TOFU device registration) against the new server right away.
   */
  setRelayUrl(url: string | null): void;
}

const Ctx = createContext<AppData | null>(null);

export function useAppData(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAppData must be used within <AppDataProvider>');
  return v;
}

// Cheap equality so the per-journal pending set only triggers a re-render when
// its membership actually changes (syncPendingCount fires on every outbox poke).
function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

const SYNC_INTERVAL_MS = 30_000;
// While disconnected, retry authentication on this cadence so the client recovers
// on its own once the relay comes back — no need to re-enter the mnemonic.
const RECONNECT_INTERVAL_MS = 5_000;
// §6 auto-lock: drop the in-memory keys after this much inactivity. Armed only
// when a sealed seed exists — without one, locking would force re-typing the
// twelve words, punishing exactly the users who chose the stricter setting.
const AUTO_LOCK_MS = 15 * 60_000;

// Seed the timeline with the Tutorial walkthrough entries on a fresh vault.
// These stay local (not pushed); only user-created entries sync to the relay.
function seedEntries(): JournalEntry[] {
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
function seedJournalRows(now: number): Journal[] {
  return JOURNALS.map((j) => ({ ...j, createdAt: now, updatedAt: now, pristine: true }));
}

const COVER_PATTERNS: readonly string[] = ['lines', 'dots', 'grid', 'plain', 'photo'];

// A pulled journal record, shaped for the UI list. Cover strings from the wire
// are validated back into the CoverPattern union (fail-safe to 'plain').
function journalFromRecord(r: JournalRecord): Journal {
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
function journalToRecord(j: Journal): JournalRecord {
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
function adoptRecordId(local: string | undefined, pulled: string | undefined): string | undefined {
  if (!local) return pulled;
  if (!pulled) return local;
  return pulled < local ? pulled : local;
}

function mergeByLWW<T extends { id: string; updatedAt: number }>(prev: T[], incoming: T[]): T[] {
  const byId = new Map(prev.map((e) => [e.id, e]));
  for (const e of incoming) {
    const cur = byId.get(e.id);
    if (!cur || e.updatedAt > cur.updatedAt) byId.set(e.id, e);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

// Blob wants a plain ArrayBuffer; bytes from the DB/crypto layers are typed over
// ArrayBufferLike, so copy into a fresh buffer (also detaches any subarray view).
function bytesToBlob(data: Uint8Array, type: string): Blob {
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
function defaultEntryTitle(ts: number): string {
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

export function AppDataProvider({ children }: { children: ComponentChildren }): VNode {
  // The relay URL is a runtime setting (self-hosters, and Tauri has no origin to
  // infer it from). Changing it re-creates the client via this dep.
  const [relayUrl, setRelayUrlState] = useState<string>(() => resolveRelayUrl());
  const relay = useMemo(() => new RelayClient(relayUrl), [relayUrl]);
  // The durable local source of truth (wa-sqlite, §5a). `entries` below is a
  // reactive mirror of it; writes go to both so the UI updates synchronously.
  const db = useMemo(() => new LocalDb(), []);
  const [status, setStatus] = useState<SyncStatus>('locked');
  // 'none' → no seal stored; null → the startup keystore probe hasn't resolved.
  const [sealMethod, setSealMethod] = useState<'passphrase' | 'securityKey' | 'none' | null>(null);
  const hasVault = sealMethod === null ? null : sealMethod !== 'none';
  const vaultMethod = sealMethod === 'none' ? null : sealMethod;
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState(false);
  const [approvalHint, setApprovalHint] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingJournalIds, setPendingJournalIds] = useState<Set<string>>(new Set());
  // High-water mark of the outbox for the progress bar; the ref is the live value
  // the (dep-free) syncPendingCount callback reads, mirrored into state for the UI.
  const syncPeak = useRef(0);
  const [syncTotal, setSyncTotal] = useState(0);
  const [saving, setSaving] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  // Journals — tombstones included, like `entries` (stale pulled copies must not
  // resurrect a deleted notebook); consumers see the filtered live list. The
  // sample notebooks seed once per device, pristine until first edit.
  const [journals, setJournals] = useState<Journal[]>([]);
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [interviewTypes, setInterviewTypes] = useState<InterviewType[]>([]);
  const [aiSettings, setAiSettings] = useState<AiSettings | null>(null);

  const session = useRef<Session | null>(null);
  // Kept after sign-in so the background loop can re-authenticate without the mnemonic.
  const identity = useRef<Identity | null>(null);
  // The wrap key (Argon2id or PRF) while unlocked-with-persistence: lets phrase
  // rotation re-seal the new seed without re-asking for the factor.
  const wrap = useRef<WrapKey | null>(null);
  // The raw seed while unlocked: lets Preferences switch the at-rest seal
  // without re-entering the mnemonic. The in-memory identity keys are already
  // seed-derived and decrypt everything, so holding the seed adds no practical
  // exposure; auto-lock clears it with the rest.
  const seedRef = useRef<Uint8Array | null>(null);
  // False when OPFS is unavailable (older browser / SSR): we degrade to an
  // in-memory session so the app still works, just without local persistence.
  const dbReady = useRef(false);
  const cursor = useRef(0);
  const pending = useRef<Map<string, JournalEntry>>(new Map());
  // Template outbox: created/edited/tombstoned templates not yet on the relay.
  const pendingTemplates = useRef<Map<string, TemplateRecord>>(new Map());
  // Interview-type outbox: created/edited/tombstoned types not yet on the relay.
  const pendingInterviewTypes = useRef<Map<string, InterviewType>>(new Map());
  // Journal outbox: created/restyled/tombstoned notebooks not yet on the relay
  // (keyed by journal id; each carries its minted wire recordId).
  const pendingJournals = useRef<Map<string, Journal>>(new Map());
  // AI-settings outbox: the one record still waiting for a push, if any.
  const pendingAi = useRef<AiSettingsRecord | null>(null);
  // Sync bookkeeping for the AI-settings singleton (mirrored into the sealed
  // keystore record so it survives reloads).
  const aiSync = useRef<AiSyncMeta>({ updatedAt: 0, dirty: false });
  // Media upload outbox: recordings (with bytes) not yet fully on the relay.
  const pendingMedia = useRef<Map<string, MediaRecord>>(new Map());
  // Media deletion queue: confirmed deletes the relay hasn't acknowledged yet
  // (mirrored in the media_tombstones table so they survive reloads).
  const pendingMediaDeletes = useRef<Set<string>>(new Set());
  const mediaFlushing = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // One async check at startup: does a sealed seed exist on this device, and
  // under which factor?
  useEffect(() => {
    void loadSealedSeed().then((rec) => setSealMethod(!rec ? 'none' : rec.v === 2 ? 'securityKey' : 'passphrase'));
  }, []);

  // Connection-status setter for the background paths (flush/pull/connect):
  // no-ops once locked, so an in-flight sync resolving after lock() can't flip
  // the lock screen back to "online".
  const setStatusLive = useCallback((next: Exclude<SyncStatus, 'locked'>) => {
    if (identity.current) setStatus(next);
  }, []);

  // Mirror the (mutable) outbox depth into reactive state so the UI can react.
  const syncPendingCount = useCallback(() => {
    const total =
      pending.current.size +
      pendingTemplates.current.size +
      pendingInterviewTypes.current.size +
      pendingJournals.current.size +
      (pendingAi.current ? 1 : 0) +
      pendingMedia.current.size +
      pendingMediaDeletes.current.size;
    setPendingCount(total);
    // Track the run's high-water mark: grow it as more is queued, reset to 0 once
    // the outbox drains so the progress bar is the denominator for "this run".
    if (total === 0) {
      if (syncPeak.current !== 0) { syncPeak.current = 0; setSyncTotal(0); }
    } else if (total > syncPeak.current) {
      syncPeak.current = total;
      setSyncTotal(total);
    }
    // Per-notebook view of the entry outbox for the journal-card sync badge.
    const js = new Set<string>();
    for (const e of pending.current.values()) js.add(e.journalId);
    setPendingJournalIds((prev) => (sameSet(prev, js) ? prev : js));
  }, []);

  // Upload queued recordings one media object at a time (chunked inside uploadMedia),
  // then push queued deletions. Runs after the entry flush so the attachment
  // metadata usually lands first. Uploads strictly before deletions: a recording
  // deleted while its upload was already snapshotted gets uploaded, then removed
  // by its tombstone — never resurrected the other way around (the per-run
  // ordering below is what carries that invariant).
  //
  // One failing upload must NOT abort the rest of the run. The worst case was a
  // large film that keeps failing (flaky network mid-transfer, or a vault the
  // render pushed over the relay quota → 413 on every chunk): with a single
  // try/catch it starved everything queued behind it — above all the deletions,
  // which are exactly how an over-quota vault frees space (the relay exempts
  // tombstones from the quota for that reason). So: per-item error handling,
  // failed items stay queued for the next flush, and deletions always run.
  const flushMedia = useCallback(async () => {
    const s = session.current;
    if (!s || mediaFlushing.current) return;
    if (pendingMedia.current.size === 0 && pendingMediaDeletes.current.size === 0) return;
    mediaFlushing.current = true;
    let failure: unknown = null;
    try {
      for (const rec of [...pendingMedia.current.values()]) {
        if (!rec.data) {
          pendingMedia.current.delete(rec.id); // nothing to upload (shouldn't happen)
          continue;
        }
        try {
          await uploadMedia(relay, s.token, s.identity.mediaKey, rec.id, rec.data);
          pendingMedia.current.delete(rec.id);
          if (dbReady.current) void db.markMediaSynced(rec.id);
          syncPendingCount();
        } catch (e) {
          failure = e; // stays queued; the next flush retries
        }
      }
      for (const id of [...pendingMediaDeletes.current]) {
        try {
          await relay.deleteMedia(s.token, id); // idempotent on the relay
          pendingMediaDeletes.current.delete(id);
          if (dbReady.current) void db.clearMediaTombstone(id);
          syncPendingCount();
        } catch (e) {
          failure = e;
        }
      }
      // 503 = relay has no object store configured; recordings stay queued
      // locally without flapping the connection indicator to "offline".
      if (failure && !(failure instanceof RelayError && failure.status === 503)) setStatusLive('offline');
    } finally {
      mediaFlushing.current = false;
    }
  }, [relay, db, syncPendingCount, setStatusLive]);

  const flush = useCallback(async () => {
    const s = session.current;
    if (!s) return;
    if (
      pending.current.size === 0 &&
      pendingTemplates.current.size === 0 &&
      pendingInterviewTypes.current.size === 0 &&
      pendingJournals.current.size === 0 &&
      pendingAi.current === null
    ) {
      void flushMedia(); // no dirty records, but recordings may still be queued
      return;
    }
    const batch = [...pending.current.values()];
    const tplBatch = [...pendingTemplates.current.values()];
    const itvBatch = [...pendingInterviewTypes.current.values()];
    const jrnBatch = [...pendingJournals.current.values()];
    const aiBatch = pendingAi.current;
    setSaving(true);
    try {
      // Any per-record answer settles that record — applied, or rejected because
      // the relay already holds this clock or newer (e.g. a retry after a lost
      // ack). Retire exactly the snapshotted version: the identity check keeps an
      // edit queued if it replaced the record while the push was in flight, same
      // as the aiBatch guard below.
      const acked = await pushEntries(relay, s.token, s.identity.dataKey, batch);
      for (const e of batch) if (acked.has(e.id) && pending.current.get(e.id) === e) pending.current.delete(e.id);
      // Clear the dirty flag locally for exactly the versions the relay settled.
      if (dbReady.current) void db.markSynced(batch.filter((e) => acked.has(e.id)));
      const ackedTpl = await pushTemplates(relay, s.token, s.identity.dataKey, tplBatch);
      for (const t of tplBatch) if (ackedTpl.has(t.id) && pendingTemplates.current.get(t.id) === t) pendingTemplates.current.delete(t.id);
      if (dbReady.current) void db.markTemplatesSynced(tplBatch.filter((t) => ackedTpl.has(t.id)));
      const ackedItv = await pushInterviewTypes(relay, s.token, s.identity.dataKey, itvBatch);
      for (const t of itvBatch) if (ackedItv.has(t.id) && pendingInterviewTypes.current.get(t.id) === t) pendingInterviewTypes.current.delete(t.id);
      if (dbReady.current) void db.markInterviewTypesSynced(itvBatch.filter((t) => ackedItv.has(t.id)));
      // Journals push under their random wire record ids (§3 — the journal id
      // itself stays inside the ciphertext).
      const ackedRec = await pushJournals(relay, s.token, s.identity.dataKey, jrnBatch.map(journalToRecord));
      const ackedJrn = jrnBatch.filter((j) => j.recordId && ackedRec.has(j.recordId));
      for (const j of ackedJrn) if (pendingJournals.current.get(j.id) === j) pendingJournals.current.delete(j.id);
      if (dbReady.current) void db.markJournalsSynced(ackedJrn);
      if (aiBatch) {
        // Either outcome retires the queued record: accepted → it's on the relay;
        // rejected as stale → the relay already holds something newer and the
        // next pull brings it here.
        await pushAiSettings(relay, s.token, s.identity.dataKey, aiBatch);
        if (pendingAi.current === aiBatch) {
          pendingAi.current = null;
          aiSync.current = { recordId: aiBatch.recordId, updatedAt: aiBatch.updatedAt, dirty: false };
          if (aiBatch.settings && identity.current) {
            void storeAiSettingsRecord(sealAiSettings(identity.current.aiKey, aiBatch.settings, aiSync.current)).catch(() => undefined);
          }
        }
      }
      syncPendingCount();
      setStatusLive('online');
    } catch {
      setStatusLive('offline');
    } finally {
      setSaving(false);
    }
    void flushMedia();
  }, [relay, db, syncPendingCount, flushMedia, setStatusLive]);

  const pull = useCallback(async () => {
    const s = session.current;
    if (!s) return;
    try {
      // The relay caps a pull at one page (500 records): keep pulling until it
      // reports no more, or a fresh device bootstrapping a large vault would
      // hydrate one page per background tick while claiming to be done.
      let more = true;
      while (more) {
      const res = await pullEntries(relay, s.token, s.identity.dataKey, cursor.current);
      cursor.current = res.cursor;
      more = res.more;
      if (res.entries.length) {
        setEntries((prev) => mergeByLWW(prev, res.entries));
        // Persist the merge (the DB enforces the same LWW guard before overwriting).
        if (dbReady.current) void db.mergeRemote(res.entries);
      }
      if (res.templates.length) {
        if (dbReady.current) void db.mergeRemoteTemplates(res.templates);
        setTemplates((prev) => {
          const merged = mergeByLWW(prev, res.templates);
          // A synced copy of a built-in (someone edited or deleted it on another
          // device) retires this device's untouched seed of the same built-in —
          // the two carry different random ids, so LWW alone can't pair them.
          const syncedSlugs = new Set(res.templates.filter((t) => t.builtin).map((t) => t.builtin));
          const superseded = new Set(
            merged.filter((t) => t.pristine && t.builtin && syncedSlugs.has(t.builtin)).map((t) => t.id),
          );
          if (superseded.size === 0) return merged;
          if (dbReady.current) void db.dropTemplates([...superseded]);
          return merged.filter((t) => !superseded.has(t.id));
        });
      }
      if (res.interviewTypes.length) {
        if (dbReady.current) void db.mergeRemoteInterviewTypes(res.interviewTypes);
        setInterviewTypes((prev) => {
          const merged = mergeByLWW(prev, res.interviewTypes);
          // Same built-in supersede pass as templates: a synced copy of a built-in
          // retires this device's untouched seed of the same slug (different ids).
          const syncedSlugs = new Set(res.interviewTypes.filter((t) => t.builtin).map((t) => t.builtin));
          const superseded = new Set(
            merged.filter((t) => t.pristine && t.builtin && syncedSlugs.has(t.builtin)).map((t) => t.id),
          );
          if (superseded.size === 0) return merged;
          if (dbReady.current) void db.dropInterviewTypes([...superseded]);
          return merged.filter((t) => !superseded.has(t.id));
        });
      }
      if (res.journals.length) {
        // Journals match across devices by the journal id INSIDE the ciphertext
        // (the builtin seeds share fixed ids everywhere), so no slug machinery:
        // a pulled record beats a pristine seed outright and otherwise merges by
        // LWW. Volume is tiny, so the merge is decided here and each decided row
        // is persisted with explicit flags.
        setJournals((prev) => {
          let next = prev;
          const persist = (row: Journal, dirty: 0 | 1): void => {
            if (dbReady.current) void db.putJournalRow(row, { dirty, pristine: 0 });
          };
          for (const r of res.journals) {
            const idx = next.findIndex((j) => j.id === r.id);
            if (idx < 0) {
              // A notebook this device has never seen — created on another
              // device (tombstones land too, guarding against resurrection).
              const row = journalFromRecord(r);
              next = [...next, row];
              persist(row, 0);
              continue;
            }
            const local = next[idx];
            const recordId = adoptRecordId(local.recordId, r.recordId);
            if (local.pristine || r.updatedAt > (local.updatedAt ?? 0)) {
              // A synced copy always beats an untouched seed; otherwise LWW.
              // A queued local edit that just lost the race is retired with it.
              const row = { ...journalFromRecord(r), recordId };
              next = next.map((j, i) => (i === idx ? row : j));
              persist(row, 0);
              if (pendingJournals.current.delete(row.id)) syncPendingCount();
            } else if (recordId !== local.recordId) {
              // Content is stale but the smaller record id still gets adopted so
              // concurrent first-syncs converge onto one record.
              const row = { ...local, recordId };
              next = next.map((j, i) => (i === idx ? row : j));
              persist(row, pendingJournals.current.has(row.id) ? 1 : 0);
              if (pendingJournals.current.has(row.id)) pendingJournals.current.set(row.id, row);
            }
          }
          return next;
        });
      }
      if (res.aiSettings.length) {
        // The settings singleton: newest updatedAt wins; ids converge like journals.
        const newest = res.aiSettings.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
        const recordId = res.aiSettings.reduce(
          (id, r) => adoptRecordId(id, r.recordId),
          aiSync.current.recordId,
        );
        if (newest.updatedAt > aiSync.current.updatedAt) {
          aiSync.current = { recordId, updatedAt: newest.updatedAt, dirty: false };
          pendingAi.current = null; // a queued older edit lost the race
          if (newest.deleted || newest.settings === null) {
            void clearAiSettingsRecord();
            setAiSettings(null);
          } else {
            setAiSettings(newest.settings);
            if (identity.current) {
              void storeAiSettingsRecord(sealAiSettings(identity.current.aiKey, newest.settings, aiSync.current)).catch(() => undefined);
            }
          }
          syncPendingCount();
        } else {
          aiSync.current = { ...aiSync.current, recordId };
        }
      }
      }
      setStatusLive('online');
    } catch {
      setStatusLive('offline');
    }
  }, [relay, db, setStatusLive, syncPendingCount]);

  // (Re)establish a relay session from the stored identity, then sync. `announce`
  // shows the "connecting…" state for a user-initiated attempt; background retries
  // stay quiet on "offline" until one succeeds, so the indicator doesn't flicker.
  const connect = useCallback(
    async (announce: boolean) => {
      const id = identity.current;
      if (!id) return;
      if (announce) setStatusLive('connecting');
      try {
        session.current = await authenticate(relay, id);
        setPendingApproval(false);
        cursor.current = 0;
        await flush();
        await pull();
        setStatusLive('online');
      } catch (e) {
        if (e instanceof PendingApprovalError) {
          // The relay knows this device but the operator hasn't approved the vault.
          // Distinct from offline: the app shows the pending screen (with the hint),
          // and retryApproval() re-runs this once the operator approves.
          setPendingApproval(true);
          setStatusLive('offline');
          return;
        }
        // Local-first: identity is valid; the relay is just unreachable right now.
        setStatusLive('offline');
      }
    },
    [relay, flush, pull, setStatusLive],
  );

  // A new RelayClient (the user re-pointed the app at another server) makes
  // everything tied to the old one stale: the bearer token and the pull cursor.
  // If the new relay happened to accept the old token, a stale cursor would
  // silently skip records below the old high-water mark — so drop the session
  // and re-authenticate immediately (TOFU registration makes the device known
  // to the new relay; connect() resets the cursor).
  const prevRelay = useRef(relay);
  useEffect(() => {
    if (prevRelay.current === relay) return; // mount / unrelated re-render
    prevRelay.current = relay;
    if (!identity.current) return;
    session.current = null;
    cursor.current = 0;
    void connect(true);
  }, [relay, connect]);

  // Shared tail of signIn and unlock: derive the identity from the seed, open
  // the per-owner DB, hydrate the UI, and kick off the first sync.
  const startSession = useCallback(
    async (seed: Uint8Array) => {
      const id = deriveIdentity(seed); // local, synchronous
      seedRef.current = seed;
      identity.current = id;
      setOwnerId(id.ownerId);
      setApprovalHint(id.approvalHint);
      // Restore the AI settings, if this vault sealed any on this device. A
      // record sealed by a different vault fails the AEAD tag → stays null.
      void loadAiSettingsRecord().then((rec) => {
        if (!rec || identity.current !== id) return;
        try {
          const settings = openAiSettings(id.aiKey, rec);
          setAiSettings(settings);
          // Records sealed before AI-settings sync carry no meta: stamp them
          // now and queue a one-time push so this device seeds the relay (a
          // newer record from another device wins on the next pull anyway).
          const meta = rec.sync ?? { recordId: undefined, updatedAt: Date.now(), dirty: true };
          aiSync.current = meta;
          if (meta.dirty) {
            pendingAi.current = {
              recordId: meta.recordId ?? newRecordId(),
              settings,
              updatedAt: meta.updatedAt,
            };
            aiSync.current = { ...meta, recordId: pendingAi.current.recordId };
            syncPendingCount();
            void flush();
          }
        } catch {
          /* tampered or another vault's record — AI stays unconfigured */
        }
      });
      // Leave the lock screen immediately: loading the SQLite wasm and the
      // first relay sync take visible time — the app shell shows "connecting"
      // + the first-sync notice instead of freezing.
      setStatus('connecting');
      setBootstrapping(true);
      try {
        // Open the per-owner local DB and hydrate the timeline from it.
        await db.open(id.ownerId);
        dbReady.current = true;
        let local = await db.allEntries();
        if (local.length === 0) {
          // First run on this device: lay down the lived-in sample timeline.
          // Seed rows are written non-dirty, so they stay local and never push.
          local = seedEntries();
          await db.mergeRemote(local);
        }
        setEntries([...local].sort((a, b) => b.updatedAt - a.updatedAt));
        // Templates: first run on this device (no rows at all, tombstones
        // included) lays down the built-in seeds — pristine + non-dirty, so
        // they stay local until the user makes one their own.
        let localTpl = await db.allTemplates();
        if ((await db.templateCount()) === 0) {
          localTpl = seedBuiltinTemplates(Date.now());
          await db.seedTemplates(localTpl);
        }
        setTemplates(localTpl);
        // Interview types: same once-per-device built-in seeding as templates.
        let localItv = await db.allInterviewTypes();
        if ((await db.interviewTypeCount()) === 0) {
          localItv = seedBuiltinInterviews(Date.now());
          await db.seedInterviewTypes(localItv);
        }
        setInterviewTypes(localItv);
        // Journals: same once-per-device seeding — pristine until first edit (a
        // tombstoned sample notebook keeps its row, so deleting one sticks).
        let localJournals = await db.allJournals();
        if ((await db.journalCount()) === 0) {
          localJournals = seedJournalRows(Date.now());
          await db.seedJournals(localJournals);
        }
        // Journal outbox first: rows marked dirty by the v8 migration predate
        // wire ids — mint one and let the hydrated state carry it too.
        for (const j of await db.dirtyJournals()) {
          const row = j.recordId ? j : { ...j, recordId: newRecordId() };
          if (!j.recordId) {
            void db.putJournalRow(row, { dirty: 1, pristine: 0 });
            localJournals = localJournals.map((x) => (x.id === row.id ? row : x));
          }
          pendingJournals.current.set(row.id, row);
        }
        setJournals(localJournals);
        // Rebuild the outboxes from work left unsynced by a previous offline session.
        for (const e of await db.dirtyEntries()) pending.current.set(e.id, e);
        for (const t of await db.dirtyTemplates()) pendingTemplates.current.set(t.id, t);
        for (const t of await db.dirtyInterviewTypes()) pendingInterviewTypes.current.set(t.id, t);
        for (const m of await db.unsyncedMedia()) pendingMedia.current.set(m.id, m);
        for (const id of await db.mediaTombstones()) pendingMediaDeletes.current.add(id);
        syncPendingCount();
      } catch {
        // OPFS unavailable: run in-memory only (no persistence this session).
        dbReady.current = false;
        setEntries((prev) => (prev.length ? prev : seedEntries()));
        setTemplates((prev) => (prev.length ? prev : seedBuiltinTemplates(Date.now())));
        setInterviewTypes((prev) => (prev.length ? prev : seedBuiltinInterviews(Date.now())));
        setJournals((prev) => (prev.length ? prev : seedJournalRows(Date.now())));
      }
      try {
        await connect(true);
      } finally {
        // First sync attempt is over (pulled, or definitively offline) — empty
        // journals now mean "empty", no longer "still arriving".
        setBootstrapping(false);
      }
    },
    [db, connect, flush, syncPendingCount],
  );

  const signIn: AppData['signIn'] = useCallback(
    async (mnemonic, seal) => {
      if (seal?.method === 'securityKey') {
        // Ceremony first — a cancelled or unsupported enrollment rejects before
        // any state changes, and the UI keeps its previous seal untouched.
        // Errors surface (unlike the passphrase keystore-catch below): the user
        // must know the key did NOT get set up.
        const enrolled = await enrollPrfCredential();
        const seed = mnemonicToSeed(mnemonic);
        const sealed = sealSeedWithPrfSecret(enrolled.secret, enrolled, seed);
        await storeSealedSeed(sealed.record);
        wrap.current = sealed.wrap;
        setSealMethod('securityKey');
        await startSession(seed);
        return;
      }
      const seed = mnemonicToSeed(mnemonic);
      if (seal?.method === 'passphrase') {
        try {
          // Seal first, while the onboarding screen still shows its busy state
          // (argon2idAsync yields, so the UI keeps painting).
          const sealed = await sealSeed(seed, seal.passphrase);
          await storeSealedSeed(sealed.record);
          wrap.current = sealed.wrap;
          setSealMethod('passphrase');
        } catch {
          // Keystore unavailable — degrade to the nothing-persisted mode.
          wrap.current = null;
          setSealMethod('none');
        }
      } else {
        // An explicit phrase entry without a seal choice replaces whatever
        // choice was stored before — possibly even a different account's seed.
        wrap.current = null;
        void clearSealedSeed();
        setSealMethod('none');
      }
      await startSession(seed);
    },
    [startSession],
  );

  const unlock: AppData['unlock'] = useCallback(
    async (passphrase) => {
      const record = await loadSealedSeed();
      if (!record) {
        setSealMethod('none');
        throw new Error('no sealed seed on this device');
      }
      if (record.v !== 1) throw new Error('this device unlocks with a security key');
      const opened = await openSeed(record, passphrase); // throws on a wrong passphrase
      wrap.current = opened.wrap;
      await startSession(opened.seed);
    },
    [startSession],
  );

  const unlockWithKey: AppData['unlockWithKey'] = useCallback(async () => {
    const record = await loadSealedSeed();
    if (!record) {
      setSealMethod('none');
      throw new Error('no sealed seed on this device');
    }
    if (record.v !== 2) throw new Error('this device unlocks with a passphrase');
    const secret = await evalPrf(record.credentialId, record.prfSalt);
    const opened = openSeedWithPrfSecret(record, secret); // throws on the wrong key (AEAD tag)
    wrap.current = opened.wrap;
    await startSession(opened.seed);
  }, [startSession]);

  const setDeviceUnlock: AppData['setDeviceUnlock'] = useCallback(async (choice) => {
    const seed = seedRef.current;
    if (!seed) throw new Error('not signed in');
    if (choice.method === 'off') {
      wrap.current = null;
      await clearSealedSeed();
      setSealMethod('none');
      return;
    }
    // Both enroll paths: seal + store first, replace the in-memory wrap key and
    // the stored record only on success — a failure leaves the previous seal
    // fully working.
    if (choice.method === 'securityKey') {
      const enrolled = await enrollPrfCredential();
      const sealed = sealSeedWithPrfSecret(enrolled.secret, enrolled, seed);
      await storeSealedSeed(sealed.record);
      wrap.current = sealed.wrap;
      setSealMethod('securityKey');
      return;
    }
    const sealed = await sealSeed(seed, choice.passphrase);
    await storeSealedSeed(sealed.record);
    wrap.current = sealed.wrap;
    setSealMethod('passphrase');
  }, []);

  // Pending-approval screen "Check again": re-run the authenticate → sync path.
  // A success clears pendingApproval (in connect); a still-pending relay re-sets it.
  const retryApproval = useCallback(() => {
    void connect(true);
  }, [connect]);

  const lock: AppData['lock'] = useCallback(() => {
    // Drop references rather than zeroing the key bytes: an in-flight flush
    // still holds them, and zeroing under a running encrypt would push garbage
    // ciphertext. setStatusLive keeps that straggler from re-opening the UI.
    // A film render outlives the editor by design; it must not outlive the
    // unlocked vault, since its output would have nowhere to be written.
    stopAllRenders();
    session.current = null;
    identity.current = null;
    wrap.current = null;
    seedRef.current = null;
    setOwnerId(null);
    setPendingApproval(false);
    setApprovalHint(null);
    cursor.current = 0;
    pending.current.clear();
    pendingTemplates.current.clear();
    pendingInterviewTypes.current.clear();
    pendingJournals.current.clear();
    pendingAi.current = null;
    aiSync.current = { updatedAt: 0, dirty: false };
    pendingMedia.current.clear();
    pendingMediaDeletes.current.clear();
    if (dbReady.current) db.close();
    dbReady.current = false;
    setEntries([]);
    setTemplates([]);
    setInterviewTypes([]);
    setAiSettings(null); // the decrypted API key leaves memory with the keys
    setJournals([]);
    setPendingCount(0);
    setSaving(false);
    setBootstrapping(false);
    setStatus('locked');
  }, [db]);

  // §6 auto-lock on inactivity, armed while unlocked on a device with a sealed
  // seed (unlocking again is one passphrase away, and the outboxes are durable
  // in the local DB, so nothing pending is lost).
  useEffect(() => {
    if (status === 'locked' || !hasVault) return;
    let t = setTimeout(lock, AUTO_LOCK_MS);
    const bump = (): void => {
      clearTimeout(t);
      t = setTimeout(lock, AUTO_LOCK_MS);
    };
    const events = ['pointerdown', 'keydown'] as const;
    for (const ev of events) window.addEventListener(ev, bump, { passive: true });
    return () => {
      clearTimeout(t);
      for (const ev of events) window.removeEventListener(ev, bump);
    };
  }, [status, hasVault, lock]);

  const createEntry: AppData['createEntry'] = useCallback(
    (input) => {
      const now = Date.now();
      const entry: JournalEntry = {
        id: newEntryId(),
        journalId: input.journalId,
        title: input.title ?? defaultEntryTitle(now),
        bodyText: input.bodyText ?? '',
        bodyJson: input.bodyJson,
        labels: input.labels ?? [],
        createdAt: now,
        updatedAt: now,
      };
      setEntries((prev) => mergeByLWW(prev, [entry]));
      if (dbReady.current) void db.putLocal(entry);
      pending.current.set(entry.id, entry);
      syncPendingCount();
      void flush();
      return entry;
    },
    [db, flush, syncPendingCount],
  );

  const updateEntry: AppData['updateEntry'] = useCallback(
    (id, patch) => {
      const now = Date.now();
      setEntries((prev) => {
        const cur = prev.find((e) => e.id === id);
        if (!cur) return prev;
        const next: JournalEntry = { ...cur, ...patch, updatedAt: now };
        if (dbReady.current) void db.putLocal(next);
        pending.current.set(id, next);
        syncPendingCount();
        void flush();
        return mergeByLWW(prev, [next]);
      });
    },
    [db, flush, syncPendingCount],
  );

  // Write a finished film into its video-interview node. Separate from
  // updateEntry because the render can outlive the editor that started it (the
  // handle lives in video/film.ts, not in a component), so the caller has no
  // reliable view of the entry's current body — the functional updater does.
  const attachFilm: AppData['attachFilm'] = useCallback(
    (entryId, sessionId, film) => {
      const now = Date.now();
      setEntries((prev) => {
        const cur = prev.find((e) => e.id === entryId);
        if (!cur) return prev;
        const bodyJson = setFilmAttr(cur.bodyJson, sessionId, film, now);
        if (!bodyJson) return prev; // entry or node gone — drop it rather than guess
        const next: JournalEntry = {
          ...cur,
          bodyJson,
          bodyText: docToText(JSON.parse(bodyJson) as JSONContent),
          updatedAt: now,
        };
        if (dbReady.current) void db.putLocal(next);
        pending.current.set(entryId, next);
        syncPendingCount();
        void flush();
        return mergeByLWW(prev, [next]);
      });
    },
    [db, flush, syncPendingCount],
  );

  // Same shape for a transcript landing after the interview sheet closed: the
  // functional updater reads the entry's current body, so it composes with
  // concurrent writes (other transcripts of the same run, a finished film).
  const attachTranscript: AppData['attachTranscript'] = useCallback(
    (entryId, sessionId, cardIndex, transcript) => {
      const now = Date.now();
      setEntries((prev) => {
        const cur = prev.find((e) => e.id === entryId);
        if (!cur) return prev;
        const bodyJson = setTranscriptAttr(cur.bodyJson, sessionId, cardIndex, transcript);
        if (!bodyJson) return prev; // entry or node gone — drop it rather than guess
        const next: JournalEntry = {
          ...cur,
          bodyJson,
          bodyText: docToText(JSON.parse(bodyJson) as JSONContent),
          updatedAt: now,
        };
        if (dbReady.current) void db.putLocal(next);
        pending.current.set(entryId, next);
        syncPendingCount();
        void flush();
        return mergeByLWW(prev, [next]);
      });
    },
    [db, flush, syncPendingCount],
  );

  const newJournal = useCallback(
    (j: Journal) => {
      const now = Date.now();
      const rec: Journal = { ...j, createdAt: now, updatedAt: now, recordId: newRecordId(), pristine: false, deleted: false };
      setJournals((prev) => [...prev, rec]);
      if (dbReady.current) void db.putJournalRow(rec, { dirty: 1, pristine: 0 });
      pendingJournals.current.set(rec.id, rec);
      syncPendingCount();
      void flush();
    },
    [db, flush, syncPendingCount],
  );

  const updateJournal: AppData['updateJournal'] = useCallback(
    (id, patch) => {
      const cur = journals.find((j) => j.id === id);
      if (!cur) return;
      // The first edit of a sample seed turns it into a real synced record
      // (pristine cleared); the fixed seed id inside the ciphertext lets other
      // devices pair it with their own copy of the same notebook.
      const updated: Journal = {
        ...cur,
        ...patch,
        pristine: false,
        recordId: cur.recordId ?? newRecordId(),
        updatedAt: Date.now(),
      };
      setJournals((prev) => prev.map((j) => (j.id === id ? updated : j)));
      if (dbReady.current) void db.putJournalRow(updated, { dirty: 1, pristine: 0 });
      pendingJournals.current.set(id, updated);
      syncPendingCount();
      void flush();
    },
    [db, flush, journals, syncPendingCount],
  );

  const createTemplate: AppData['createTemplate'] = useCallback(
    (input) => {
      const now = Date.now();
      const t: TemplateRecord = {
        id: newTemplateId(),
        name: input.name,
        bodyText: input.bodyText ?? '',
        bodyJson: input.bodyJson,
        createdAt: now,
        updatedAt: now,
      };
      setTemplates((prev) => mergeByLWW(prev, [t]));
      if (dbReady.current) void db.putLocalTemplate(t);
      pendingTemplates.current.set(t.id, t);
      syncPendingCount();
      void flush();
      return t;
    },
    [db, flush, syncPendingCount],
  );

  const updateTemplate: AppData['updateTemplate'] = useCallback(
    (id, patch) => {
      const now = Date.now();
      setTemplates((prev) => {
        const cur = prev.find((t) => t.id === id);
        if (!cur) return prev;
        // The first edit of a built-in seed turns it into a real synced record
        // (pristine is cleared); the builtin slug rides along so other devices
        // retire their own seed of it.
        const next: TemplateRecord = { ...cur, ...patch, pristine: false, updatedAt: now };
        if (dbReady.current) void db.putLocalTemplate(next);
        pendingTemplates.current.set(id, next);
        syncPendingCount();
        void flush();
        return mergeByLWW(prev, [next]);
      });
    },
    [db, flush, syncPendingCount],
  );

  const deleteTemplate: AppData['deleteTemplate'] = useCallback(
    (id) => {
      const now = Date.now();
      setTemplates((prev) => {
        const cur = prev.find((t) => t.id === id);
        if (!cur) return prev;
        // Tombstone rather than drop: the deletion must out-sync other devices'
        // copies — and, via the builtin slug, their pristine seeds too.
        const next: TemplateRecord = { ...cur, deleted: true, pristine: false, updatedAt: now };
        if (dbReady.current) void db.putLocalTemplate(next);
        pendingTemplates.current.set(id, next);
        syncPendingCount();
        void flush();
        return mergeByLWW(prev, [next]);
      });
    },
    [db, flush, syncPendingCount],
  );

  const createInterviewType: AppData['createInterviewType'] = useCallback(
    (input) => {
      const now = Date.now();
      const t: InterviewType = {
        id: newTemplateId(),
        name: input.name,
        intro: input.intro ?? '',
        prompt: input.prompt ?? '',
        createdAt: now,
        updatedAt: now,
      };
      setInterviewTypes((prev) => mergeByLWW(prev, [t]));
      if (dbReady.current) void db.putLocalInterviewType(t);
      pendingInterviewTypes.current.set(t.id, t);
      syncPendingCount();
      void flush();
      return t;
    },
    [db, flush, syncPendingCount],
  );

  const updateInterviewType: AppData['updateInterviewType'] = useCallback(
    (id, patch) => {
      const now = Date.now();
      setInterviewTypes((prev) => {
        const cur = prev.find((t) => t.id === id);
        if (!cur) return prev;
        // The first edit of a built-in seed turns it into a real synced record
        // (pristine cleared); the builtin slug rides along so other devices retire it.
        const next: InterviewType = { ...cur, ...patch, pristine: false, updatedAt: now };
        if (dbReady.current) void db.putLocalInterviewType(next);
        pendingInterviewTypes.current.set(id, next);
        syncPendingCount();
        void flush();
        return mergeByLWW(prev, [next]);
      });
    },
    [db, flush, syncPendingCount],
  );

  const deleteInterviewType: AppData['deleteInterviewType'] = useCallback(
    (id) => {
      const now = Date.now();
      setInterviewTypes((prev) => {
        const cur = prev.find((t) => t.id === id);
        if (!cur) return prev;
        // Tombstone (built-ins included) so the deletion out-syncs other devices'
        // copies — and, via the builtin slug, their pristine seeds too.
        const next: InterviewType = { ...cur, deleted: true, pristine: false, updatedAt: now };
        if (dbReady.current) void db.putLocalInterviewType(next);
        pendingInterviewTypes.current.set(id, next);
        syncPendingCount();
        void flush();
        return mergeByLWW(prev, [next]);
      });
    },
    [db, flush, syncPendingCount],
  );

  // Persist new AI settings sealed under the vault-derived key, and queue them
  // for the oplog (kind: 'aiSettings' inside the ciphertext) so the assistant
  // configuration — API key included — follows the vault to its other devices.
  // The plaintext only ever lives in this state object while unlocked; on the
  // wire and on the relay it is ciphertext like everything else.
  const saveAiSettings: AppData['saveAiSettings'] = useCallback(
    async (s) => {
      const id = identity.current;
      if (!id) throw new Error('not signed in');
      const now = Date.now();
      const recordId = aiSync.current.recordId ?? newRecordId();
      aiSync.current = { recordId, updatedAt: now, dirty: true };
      if (s === null) {
        await clearAiSettingsRecord();
        setAiSettings(null);
        // Tombstone so the clearing reaches the other devices too.
        pendingAi.current = { recordId, settings: null, updatedAt: now, deleted: true };
      } else {
        await storeAiSettingsRecord(sealAiSettings(id.aiKey, s, aiSync.current));
        setAiSettings(s);
        pendingAi.current = { recordId, settings: s, updatedAt: now };
      }
      syncPendingCount();
      void flush();
    },
    [flush, syncPendingCount],
  );

  // Store a recording: bytes go to the local DB + media outbox. The attachment
  // metadata is returned for the editor to embed as an inline node in the entry
  // document (bodyJson), which rides inside the encrypted entry body — so other
  // devices learn the media id while the relay only ever sees that random id
  // and ciphertext chunks.
  const addMedia: AppData['addMedia'] = useCallback(
    async (entryId, kind, blob, meta) => {
      const data = new Uint8Array(await blob.arrayBuffer());
      if (data.length === 0) return null;
      const now = Date.now();
      const fallbackMime =
        kind === 'audio' ? 'audio/webm' : kind === 'video' ? 'video/webm' : kind === 'image' ? 'image/jpeg' : 'application/octet-stream';
      const att: MediaAttachment = {
        id: newMediaId(),
        kind,
        mime: blob.type || fallbackMime,
        bytes: data.length,
        durationMs: meta?.durationMs,
        name: meta?.name,
        width: meta?.width,
        height: meta?.height,
        createdAt: now,
      };
      const rec: MediaRecord = {
        id: att.id,
        entryId,
        mime: att.mime,
        bytes: att.bytes,
        durationMs: meta?.durationMs,
        createdAt: now,
        data,
        synced: false,
      };
      if (dbReady.current) void db.putMedia(rec);
      pendingMedia.current.set(rec.id, rec);
      syncPendingCount();
      void flush();
      return att;
    },
    [db, flush, syncPendingCount],
  );

  // Permanent deletion (the caller has already removed the entry's reference
  // and shown the "cannot be undone" confirmation): purge the local bytes and
  // queue the relay-side delete (DELETE /v1/media/{id}). The tombstone persists
  // until the relay acknowledges, so deletes made offline still happen later.
  const removeMedia: AppData['removeMedia'] = useCallback(
    (mediaId) => {
      pendingMedia.current.delete(mediaId);
      pendingMediaDeletes.current.add(mediaId);
      if (dbReady.current) {
        void db.deleteMedia(mediaId).catch(() => undefined);
        void db.addMediaTombstone(mediaId).catch(() => undefined);
      }
      syncPendingCount();
      void flushMedia(); // reach the relay now if we're online
    },
    [db, syncPendingCount, flushMedia],
  );

  // Tombstone an entry (the caller has shown the confirmation). The tombstone
  // row keeps winning LWW against stale copies and pushes like any edit, so the
  // deletion reaches every device; the entry's recordings — inline nodes and
  // legacy attachments alike — go through the same confirmed-delete path as a
  // single recording (local purge + relay DELETE).
  const deleteEntry: AppData['deleteEntry'] = useCallback(
    (id) => {
      const now = Date.now();
      let victim: JournalEntry | undefined;
      setEntries((prev) => {
        const cur = prev.find((e) => e.id === id);
        if (!cur || cur.deleted) return prev;
        victim = cur;
        const next: JournalEntry = { ...cur, deleted: true, updatedAt: now };
        if (dbReady.current) void db.putLocal(next);
        pending.current.set(id, next);
        return mergeByLWW(prev, [next]);
      });
      if (!victim) return;
      const mediaIds = new Set((victim.attachments ?? []).map((a) => a.id));
      if (victim.bodyJson) {
        try {
          for (const m of docMediaIds(JSON.parse(victim.bodyJson) as JSONContent)) mediaIds.add(m);
        } catch {
          /* unparseable body — nothing to collect */
        }
      }
      for (const m of mediaIds) removeMedia(m);
      syncPendingCount();
      void flush();
    },
    [db, flush, syncPendingCount, removeMedia],
  );

  // Delete a whole notebook (the caller has shown the typed-"delete" sheet).
  // Every entry in it tombstones like a single entry delete — one batch, one
  // flush — and the journal itself tombstones through the oplog so the notebook
  // disappears from the vault's other devices too.
  const deleteJournal: AppData['deleteJournal'] = useCallback(
    (id) => {
      const now = Date.now();
      const mediaIds = new Set<string>();
      setEntries((prev) => {
        const victims = prev.filter((e) => e.journalId === id && !e.deleted);
        if (victims.length === 0) return prev;
        const tombstones = victims.map((e): JournalEntry => ({ ...e, deleted: true, updatedAt: now }));
        for (const e of tombstones) {
          if (dbReady.current) void db.putLocal(e);
          pending.current.set(e.id, e);
        }
        for (const v of victims) {
          for (const a of v.attachments ?? []) mediaIds.add(a.id);
          if (v.bodyJson) {
            try {
              for (const m of docMediaIds(JSON.parse(v.bodyJson) as JSONContent)) mediaIds.add(m);
            } catch {
              /* unparseable body — nothing to collect */
            }
          }
        }
        return mergeByLWW(prev, tombstones);
      });
      for (const m of mediaIds) removeMedia(m);
      setJournals((prev) => {
        const cur = prev.find((j) => j.id === id);
        if (!cur || cur.deleted) return prev;
        const tombstone: Journal = {
          ...cur,
          deleted: true,
          pristine: false,
          recordId: cur.recordId ?? newRecordId(),
          updatedAt: now,
        };
        if (dbReady.current) void db.putJournalRow(tombstone, { dirty: 1, pristine: 0 });
        pendingJournals.current.set(id, tombstone);
        return prev.map((j) => (j.id === id ? tombstone : j));
      });
      syncPendingCount();
      void flush();
    },
    [db, flush, syncPendingCount, removeMedia],
  );

  // Resolve attachment bytes for playback: outbox → local DB → relay download
  // (decrypted with the media key, then cached locally for next time).
  const mediaBlob: AppData['mediaBlob'] = useCallback(
    async (entryId, att) => {
      const queued = pendingMedia.current.get(att.id);
      if (queued?.data) return bytesToBlob(queued.data, att.mime);
      if (dbReady.current) {
        const row = await db.getMedia(att.id).catch(() => null);
        if (row?.data) return bytesToBlob(row.data, row.mime || att.mime);
      }
      const s = session.current;
      if (!s) return null;
      try {
        const data = await downloadMedia(relay, s.token, s.identity.mediaKey, att.id);
        if (dbReady.current) {
          void db.putMedia({
            id: att.id,
            entryId,
            mime: att.mime,
            bytes: att.bytes,
            durationMs: att.durationMs,
            createdAt: att.createdAt,
            data,
            synced: true,
          });
        }
        return bytesToBlob(data, att.mime);
      } catch {
        return null; // offline, not yet uploaded by the other device, or relay has no object store
      }
    },
    [db, relay],
  );

  // Small list thumbnail for an image: cached downscaled JPEG → generate from the
  // full bytes once → persist. Keeps the overview lists from decoding full-res
  // images into the DOM. Non-images have no preview; the editor uses mediaBlob.
  const mediaThumb: AppData['mediaThumb'] = useCallback(
    async (entryId, att) => {
      if (att.kind !== 'image') return null;
      if (dbReady.current) {
        const cached = await db.getMediaThumb(att.id).catch(() => null);
        if (cached) return bytesToBlob(cached, 'image/jpeg');
      }
      const full = await mediaBlob(entryId, att);
      if (!full) return null;
      try {
        const thumb = await makeThumbnail(full);
        if (dbReady.current) {
          const bytes = new Uint8Array(await thumb.arrayBuffer());
          void db.putMediaThumb(att.id, bytes).catch(() => undefined);
        }
        return thumb;
      } catch {
        return full; // unsupported format — fall back to the original bytes
      }
    },
    [db, mediaBlob],
  );

  // Replace the recovery phrase (sync/rotate.ts). The rotation sheet blocks edits
  // while this runs; flipping to 'connecting' first tears down the background
  // interval so no flush/pull races the migration against the old account.
  const rotatePhrase: AppData['rotatePhrase'] = useCallback(
    async (newMnemonic, onProgress) => {
      const s = session.current;
      if (!s) throw new Error('not signed in');
      setStatus('connecting');
      try {
        const oldOwnerId = s.ownerId;
        const localMedia = dbReady.current
          ? await db.allMedia().catch(() => [...pendingMedia.current.values()])
          : [...pendingMedia.current.values()];
        const mediaById = new Map(localMedia.map((m) => [m.id, m]));

        const result = await rotateAccount({
          relay,
          old: s,
          newMnemonic,
          localDirty: [...pending.current.values()],
          localDirtyTemplates: [...pendingTemplates.current.values()],
          localDirtyInterviewTypes: [...pendingInterviewTypes.current.values()],
          localDirtyJournals: [...pendingJournals.current.values()].map(journalToRecord),
          localDirtyAiSettings: pendingAi.current ?? undefined,
          localMediaBytes: (id) => Promise.resolve(mediaById.get(id)?.data ?? null),
          onProgress,
        });

        // The vault now lives under the new owner: swap the in-memory identity.
        identity.current = result.session.identity;
        session.current = result.session;
        seedRef.current = mnemonicToSeed(newMnemonic);
        setOwnerId(result.session.ownerId);
        cursor.current = 0;
        pending.current.clear();
        pendingTemplates.current.clear();
        pendingInterviewTypes.current.clear();
        pendingJournals.current.clear();
        pendingAi.current = null;
        aiSync.current = { ...aiSync.current, dirty: false };
        pendingMedia.current.clear();

        // Everything the relay holds lands non-dirty; local-only rows (e.g. the
        // sample timeline and pristine template/interview seeds) move across unchanged.
        const all = mergeByLWW(entries, result.entries);
        const allTpl = mergeByLWW(templates, result.templates);
        const allItv = mergeByLWW(interviewTypes, result.interviewTypes);
        // Journals merge by the id inside the ciphertext, same rules as pull.
        const jrnById = new Map(journals.map((j) => [j.id, j]));
        for (const r of result.journals) {
          const local = jrnById.get(r.id);
          if (!local || local.pristine || r.updatedAt > (local.updatedAt ?? 0)) {
            jrnById.set(r.id, { ...journalFromRecord(r), recordId: adoptRecordId(local?.recordId, r.recordId) });
          }
        }
        const allJrn = [...jrnById.values()];

        // Re-home the local DB under the new owner_id, then destroy the old
        // per-owner directory — it holds plaintext under a possibly-leaked identity.
        if (dbReady.current) {
          db.close();
          try {
            await db.open(result.session.ownerId);
            await db.mergeRemote(all);
            // Seeds keep their pristine/local-only standing; everything else
            // is on the new relay account already, so it lands non-dirty.
            await db.seedTemplates(allTpl.filter((t) => t.pristine));
            await db.mergeRemoteTemplates(allTpl.filter((t) => !t.pristine));
            await db.seedInterviewTypes(allItv.filter((t) => t.pristine));
            await db.mergeRemoteInterviewTypes(allItv.filter((t) => !t.pristine));
            // Journals: pristine seeds keep their local-only standing; everything
            // else was re-pushed by the rotation, so it lands non-dirty.
            await db.seedJournals(allJrn.filter((j) => j.pristine));
            for (const j of allJrn.filter((j) => !j.pristine)) {
              await db.putJournalRow(j, { dirty: 0, pristine: 0 });
            }
          } catch {
            dbReady.current = false;
          }
          void destroyOwnerDb(oldOwnerId);
        }
        for (const m of localMedia) {
          const rec: MediaRecord = { ...m, synced: result.uploadedMedia.has(m.id) };
          if (dbReady.current) void db.putMedia(rec);
          // Recordings the relay couldn't take (e.g. no object store) re-enter
          // the outbox and upload to the new account when it becomes possible.
          if (!rec.synced && rec.data) pendingMedia.current.set(rec.id, rec);
        }

        // Keep the at-rest seal in step with the vault: same factor (same wrap
        // key — no passphrase prompt, no WebAuthn ceremony), new seed. Left
        // alone, the stored record would "unlock" into the old identity —
        // wiped on the relay and with its local DB destroyed below. If
        // re-sealing fails, clear it instead: a lying vault is worse than no vault.
        if (wrap.current) {
          try {
            await storeSealedSeed(sealWithKey(wrap.current, mnemonicToSeed(newMnemonic)));
          } catch {
            wrap.current = null;
            void clearSealedSeed();
            setSealMethod('none');
          }
        }

        // Same for the sealed AI settings: their wrap key derives from the seed,
        // so the old record would no longer open. Re-seal under the new identity
        // (sync meta rides along — the rotation re-pushed the records already);
        // on failure, clear — AI falls back to "not configured".
        if (aiSettings) {
          try {
            await storeAiSettingsRecord(sealAiSettings(result.session.identity.aiKey, aiSettings, aiSync.current));
          } catch {
            void clearAiSettingsRecord();
            setAiSettings(null);
          }
        }

        setEntries(all);
        setTemplates(allTpl);
        setInterviewTypes(allItv);
        setJournals(allJrn);
        syncPendingCount();
        setStatus('online'); // re-arms the background loop against the new account
      } catch (e) {
        // Failed before the wipe: the old account is intact. The reconnect loop
        // re-authenticates the (unchanged) identity on its own.
        setStatus('offline');
        throw e;
      }
    },
    [relay, db, entries, templates, interviewTypes, journals, aiSettings, syncPendingCount],
  );

  // Permanently delete the vault. Relay first — only after the server confirms
  // does this device erase itself, so a failed request leaves everything intact.
  const deleteVault: AppData['deleteVault'] = useCallback(async () => {
    const s = session.current;
    if (!s) throw new Error('not signed in');
    // Tear down the background loop so no flush/pull races the wipe — and stop
    // any film render, whose output would otherwise land in a deleted vault.
    stopAllRenders();
    setStatus('connecting');
    try {
      await relay.deleteAccount(s.token);
    } catch (e) {
      // Account intact — drop to offline so the reconnect loop resumes normally.
      setStatus('offline');
      throw e;
    }
    // Point of no return: the relay copy is gone. Erase this device too — the
    // plaintext per-owner DB and any sealed seed (a seal that "unlocks" into a
    // deleted account would be a lying vault).
    if (dbReady.current) {
      db.close();
      dbReady.current = false;
    }
    void destroyOwnerDb(s.ownerId);
    wrap.current = null;
    void clearSealedSeed();
    void clearAiSettingsRecord(); // the sealed API key must not survive the vault
    setSealMethod('none');
    lock(); // drops the in-memory identity and lands on onboarding
  }, [relay, db, lock]);

  // Repoint the app at a different relay. Persist best-effort, but drive the
  // live session from the value in hand: if the localStorage write fails
  // (private mode, quota), this run still honors the user's choice instead of
  // silently reverting. The relay memo depends on relayUrl, so this swaps the
  // client; the effect below drops the old session against it.
  const setRelayUrl: AppData['setRelayUrl'] = useCallback((url) => {
    setStoredRelayUrl(url);
    setRelayUrlState(url?.trim() ? url.trim() : buildDefaultRelayUrl());
  }, []);

  // Background loop. While online: periodic flush + pull. While offline: retry the
  // relay handshake until it comes back, then resume syncing automatically.
  useEffect(() => {
    if (status === 'online') {
      timer.current = setInterval(() => {
        void flush();
        void pull();
      }, SYNC_INTERVAL_MS);
    } else if (status === 'offline') {
      timer.current = setInterval(() => {
        void connect(false);
      }, RECONNECT_INTERVAL_MS);
    } else {
      return;
    }
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [status, flush, pull, connect]);

  // Live notebook counts + last-edited labels, derived from the actual entries
  // rather than hardcoded. `last` is '' for an empty notebook so the UI can
  // distinguish "never written in" from a real timestamp.
  const journalsWithCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const latest = new Map<string, number>();
    for (const e of entries) {
      if (e.deleted) continue;
      counts.set(e.journalId, (counts.get(e.journalId) ?? 0) + 1);
      latest.set(e.journalId, Math.max(latest.get(e.journalId) ?? 0, e.updatedAt));
    }
    const now = Date.now();
    // Tombstones stay in the raw list (LWW guard against stale pulled copies)
    // but consumers only see live notebooks.
    return journals
      .filter((j) => !j.deleted)
      .map((j) => {
        const last = latest.get(j.id);
        return { ...j, count: counts.get(j.id) ?? 0, last: last ? relativeDay(last, now) : '' };
      });
  }, [journals, entries]);

  // Tombstones stay in the raw list (so LWW keeps winning against stale copies
  // and the outbox can push them) but every consumer sees only live entries.
  const liveEntries = useMemo(() => entries.filter((e) => !e.deleted), [entries]);

  // Built-in template seeds render in the active language until the user forks
  // one by editing; localizeBuiltinTemplate is a no-op for owned records. The
  // raw `templates` state stays the seed language for sync/DB — only this
  // exposed projection follows the locale. `locale` is the memo trigger.
  const { locale } = useI18n();
  const localizedTemplates = useMemo(
    () => templates.map(localizeBuiltinTemplate),
    [templates, locale],
  );
  // Same projection for the built-in interview-type seeds (name + intro).
  const localizedInterviewTypes = useMemo(
    () => interviewTypes.map(localizeBuiltinInterview),
    [interviewTypes, locale],
  );

  // Read through to the live ref every time (see the interface comment).
  const transcribeToken = useCallback(() => session.current?.token ?? null, []);

  const value: AppData = { status, hasVault, transcribeToken, vaultMethod, ownerId, pendingApproval, approvalHint, retryApproval, pendingCount, pendingJournalIds, syncTotal, saving, bootstrapping, entries: liveEntries, journals: journalsWithCounts, templates: localizedTemplates, interviewTypes: localizedInterviewTypes, aiSettings, saveAiSettings, signIn, unlock, unlockWithKey, setDeviceUnlock, lock, createEntry, updateEntry, attachFilm, attachTranscript, deleteEntry, newJournal, updateJournal, deleteJournal, createTemplate, updateTemplate, deleteTemplate, createInterviewType, updateInterviewType, deleteInterviewType, addMedia, removeMedia, mediaBlob, mediaThumb, rotatePhrase, deleteVault, relayUrl, setRelayUrl };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
