// Media attachment cards. Bytes resolve lazily through a caller-provided
// resolver (local DB → relay download + decrypt), so opening an entry never
// blocks on media and another device's recording streams in on demand.
//
// Cards are rendered in two places: inline in the document via the TipTap
// mediaAttachment node view (editor/media.tsx — the normal path), and by
// <AttachmentList> below for legacy entries whose attachments predate inline
// media and live only in the entry's attachments array.
import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JournalEntry, MediaAttachment } from '../sync/engine';
import { useAppData } from '../state/data';
import { t, fmtNumber } from '../i18n';
import { Icon } from './Icon';
import { Btn } from './primitives';
import { fmtDuration } from './VideoCapture';
import { toAiError } from '../ai/types';
import { transcribe, transcriptionConfig, transcriptionDestination, type TranscribeDestination } from '../ai/transcribe';
import { ConfirmDialog } from './ConfirmDialog';

export type MediaResolver = (att: MediaAttachment) => Promise<Blob | null>;

export function fmtBytes(n: number): string {
  if (n < 1024) return t('media.bytes.b', { n: fmtNumber(n) });
  if (n < 1024 * 1024) return t('media.bytes.kb', { n: fmtNumber(n / 1024, { maximumFractionDigits: 0 }) });
  return t('media.bytes.mb', { n: fmtNumber(n / (1024 * 1024), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
}

/** Short human noun for a media kind ("video recording", "photo", …). */
export function mediaNoun(kind: MediaAttachment['kind']): string {
  if (kind === 'audio') return t('media.noun.audio');
  if (kind === 'video') return t('media.noun.video');
  if (kind === 'image') return t('media.noun.image');
  return t('media.noun.file');
}

function mediaIcon(kind: MediaAttachment['kind']): 'mic' | 'video' | 'image' | 'file' {
  if (kind === 'audio') return 'mic';
  if (kind === 'video') return 'video';
  if (kind === 'image') return 'image';
  return 'file';
}

// The most common "not reachable yet" case is bytes another device is still
// uploading (a freshly rendered film takes a while); they usually land within
// minutes, so retry quietly a few times before leaving it to the button.
const AUTO_RETRY_DELAYS_MS = [8_000, 30_000, 90_000];

// Resolve an attachment to a playable object URL; `failed` flips on when the
// bytes aren't reachable yet (e.g. recorded on another device, not uploaded).
export function useMediaUrl(att: MediaAttachment, resolve: MediaResolver): { url: string | null; failed: boolean; retry: () => void } {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Bump to retry a failed load.
  const [attempt, setAttempt] = useState(0);
  // Background retries spent on the current attachment (capped, cheap: each is
  // one metadata GET against the relay while the card is mounted and failed).
  const autoTries = useRef(0);

  useEffect(() => {
    autoTries.current = 0;
  }, [att.id]);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    setFailed(false);
    void resolve(att).then((blob) => {
      if (cancelled) return;
      if (!blob) {
        setFailed(true);
        return;
      }
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [att.id, attempt]);

  useEffect(() => {
    if (!failed || autoTries.current >= AUTO_RETRY_DELAYS_MS.length) return;
    const timer = setTimeout(() => {
      autoTries.current += 1;
      setAttempt((n) => n + 1);
    }, AUTO_RETRY_DELAYS_MS[autoTries.current]);
    return () => clearTimeout(timer);
  }, [failed, attempt]);

  // A manual retry restores the automatic budget — the user is watching again.
  return {
    url,
    failed,
    retry: () => {
      autoTries.current = 0;
      setAttempt((n) => n + 1);
    },
  };
}

// Deleting a media item is destructive and unrecoverable (no relay-side copy the
// user can get back; local bytes are purged) — always confirm first.
export function ConfirmDeleteDialog({
  att,
  onCancel,
  onConfirm,
}: {
  att: MediaAttachment;
  onCancel: () => void;
  onConfirm: () => void;
}): VNode {
  const noun = mediaNoun(att.kind);
  const info = att.durationMs ? `${fmtDuration(att.durationMs)}, ${fmtBytes(att.bytes)}` : fmtBytes(att.bytes);
  return (
    <div
      role="dialog"
      onClick={onCancel}
      style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(30,22,16,.45)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 400, maxWidth: '100%', boxSizing: 'border-box', background: 'var(--surface)', borderRadius: 20, border: '1px solid var(--line)', padding: 22, boxShadow: '0 20px 60px rgba(30,20,12,.3)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={{ width: 36, height: 36, borderRadius: 999, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(228,87,61,.12)' }}>
            <Icon name={mediaIcon(att.kind)} size={17} color="#E4573D" />
          </span>
          <h3 style={{ fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, color: 'var(--ink)', margin: 0 }}>
            {t('media.delete.title', { noun })}
          </h3>
        </div>
        <p style={{ fontFamily: 'var(--ui)', fontSize: 13.5, lineHeight: 1.55, color: 'var(--ink-2)', margin: '0 0 18px' }}>
          {att.name
            ? t('media.delete.body', { name: att.name, noun, info })
            : t('media.delete.bodyUnnamed', { noun, info })}{' '}
          <strong style={{ color: 'var(--ink)' }}>{t('media.delete.irreversible')}</strong>
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <Btn kind="ghost" onClick={onCancel}>{t('common.cancel')}</Btn>
          <Btn kind="danger" onClick={onConfirm}>
            {t('media.delete.confirm', { noun: att.kind === 'audio' || att.kind === 'video' ? t('media.noun.recording') : noun })}
          </Btn>
        </div>
      </div>
    </div>
  );
}

/**
 * The transcript strip under a video/audio card: a collapsed "Show transcript"
 * toggle once text exists, else (when a transcription server is configured —
 * `onTranscribe` present) the retroactive "Transcribe" action with its busy and
 * error states. The caller persists the resulting text (node attrs inside the
 * encrypted body, or the legacy attachments array).
 *
 * With `onSave` the shown text is editable: speech-to-text mishears names and
 * numbers, and the transcript is what search, previews, and Ask-my-journal read
 * — so a wrong one is worse than none. Saving an empty box drops the transcript
 * (the caller stores undefined), which puts the Transcribe action back.
 */
export function TranscriptStrip({
  transcript,
  onTranscribe,
  onSave,
  dest,
}: {
  transcript?: string;
  onTranscribe?: () => Promise<void>;
  /** Persist a hand-edited transcript; empty string clears it. Omit for read-only. */
  onSave?: (text: string) => void;
  /** Where the recording would be sent; non-local destinations confirm first. */
  dest?: TranscribeDestination;
}): VNode | null {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  // Wall-clock seconds since the request left — a whisper job is one opaque
  // HTTP round-trip, so a ticking count is the honest "still working" signal
  // (a percentage would be invented).
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  if (!transcript && !onTranscribe) return null;

  const run = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onTranscribe?.();
      setOpen(true);
    } catch (e) {
      const err = toAiError(e);
      setError(
        err.hint === 'auth'
          ? t('assistant.error.keyRejectedShort')
          : err.hint === 'session'
            ? t('media.transcribe.signedOut')
            : err.hint === 'quota'
              ? t('media.transcribe.limitReached')
              : err.hint === 'model'
                ? t('media.transcribe.modelMissing')
                : t('media.transcribe.failed', { message: err.message }),
      );
    } finally {
      setBusy(false);
    }
  };

  // The per-use disclosure: a non-local destination gets a confirm naming the
  // host before any decrypted audio leaves the device. Loopback runs directly —
  // a warning that also fired for the on-device case would train people to
  // click through it.
  const start = (): void => {
    if (dest && !dest.local) setConfirming(true);
    else void run();
  };

  const startEdit = (): void => {
    setDraft(transcript ?? '');
    setOpen(true);
    setEditing(true);
  };

  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '6px 11px 8px' }}>
      {transcript ? (
        <>
          <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={() => setOpen((o) => !o)}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 600, color: 'var(--ink-3)' }}
            >
              <Icon name="quote" size={13} color="var(--ink-3)" />
              {open ? t('media.transcribe.hide') : t('media.transcribe.show')}
            </button>
            {onSave && !editing && (
              <button
                onClick={startEdit}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 600, color: 'var(--accent-ink)' }}
              >
                {t('media.transcribe.edit')}
              </button>
            )}
          </span>
          {open &&
            (editing ? (
              <>
                <textarea
                  value={draft}
                  autoFocus
                  onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
                  rows={Math.min(16, Math.max(4, draft.split('\n').length + 1))}
                  style={{ display: 'block', width: '100%', boxSizing: 'border-box', resize: 'vertical', margin: '7px 0 0', padding: '8px 10px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--ink)', fontFamily: 'var(--serif)', fontSize: 13.5, lineHeight: 1.6 }}
                />
                <span style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 7 }}>
                  <Btn
                    kind="primary"
                    size="sm"
                    onClick={() => {
                      setEditing(false);
                      onSave?.(draft.trim());
                    }}
                  >
                    {t('common.save')}
                  </Btn>
                  <Btn kind="ghost" size="sm" onClick={() => setEditing(false)}>{t('common.cancel')}</Btn>
                  <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-3)' }}>
                    {t('media.transcribe.editHint')}
                  </span>
                </span>
              </>
            ) : (
              <p style={{ fontFamily: 'var(--serif)', fontSize: 13.5, lineHeight: 1.6, color: 'var(--ink-2)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '7px 0 0' }}>
                {transcript}
              </p>
            ))}
        </>
      ) : (
        <>
          <button
            onClick={start}
            disabled={busy}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 600, color: 'var(--accent-ink)', background: 'transparent', border: '1px solid var(--line)', borderRadius: 999, padding: '4px 12px', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1 }}
          >
            {busy ? <span className="mneme-busy-dot" /> : <Icon name="quote" size={13} color="var(--accent-ink)" />}
            {busy ? (elapsed > 0 ? t('media.transcribe.busyFor', { seconds: fmtNumber(elapsed) }) : t('media.transcribe.busy')) : t('media.transcribe.action')}
          </button>
          {error && <p style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--accent-ink)', margin: '6px 0 0' }}>{error}</p>}
          {confirming && dest && (
            <ConfirmDialog
              icon="shield"
              title={t('media.transcribe.confirmTitle')}
              confirmLabel={t('media.transcribe.action')}
              onCancel={() => setConfirming(false)}
              onConfirm={() => {
                setConfirming(false);
                void run();
              }}
            >
              {t('media.transcribe.confirmBody', { host: dest.host })}
            </ConfirmDialog>
          )}
        </>
      )}
    </div>
  );
}

/** One attachment card (video, audio, image, or file): preview, caption, and confirmed delete. */
export function MediaCard({
  att,
  resolve,
  onDelete,
  onOpen,
  onTranscribe,
  onSaveTranscript,
  transcribeDest,
}: {
  att: MediaAttachment;
  resolve: MediaResolver;
  /** Called after the user confirmed; omit to hide the delete affordance. */
  onDelete?: () => void;
  /** Images only: maximize in the lightbox. */
  onOpen?: () => void;
  /** Video/audio only: transcribe the recording; the caller persists the text. */
  onTranscribe?: () => Promise<void>;
  /** Persist a hand-edited transcript ('' clears it); omit for read-only. */
  onSaveTranscript?: (text: string) => void;
  /** Where transcription goes — drives the non-local per-use confirm. */
  transcribeDest?: TranscribeDestination;
}): VNode {
  const { url, failed, retry } = useMediaUrl(att, resolve);
  const [confirming, setConfirming] = useState(false);
  const compact = att.kind === 'audio' || att.kind === 'file';

  const retryBtn = (
    <button
      onClick={retry}
      style={{ fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--accent-ink)', background: 'transparent', border: '1px solid var(--line)', borderRadius: 999, padding: '4px 12px', cursor: 'pointer' }}
    >
      {t('media.retryUnavailable')}
    </button>
  );

  const placeholder = (
    <div style={{ height: compact ? 64 : 150, display: 'flex', flexDirection: compact ? 'row' : 'column', alignItems: 'center', justifyContent: 'center', gap: 9, color: 'var(--ink-3)' }}>
      <Icon name={mediaIcon(att.kind)} size={compact ? 18 : 22} color="var(--ink-3)" />
      {failed ? retryBtn : <span style={{ fontFamily: 'var(--ui)', fontSize: 12.5 }}>{t('media.loading', { noun: mediaNoun(att.kind) })}</span>}
    </div>
  );

  const deleteBtn = onDelete && (
    <button
      onClick={() => setConfirming(true)}
      title={t('media.delete.confirm', { noun: mediaNoun(att.kind) })}
      style={{ width: 26, height: 26, borderRadius: 8, border: 'none', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--ink-3)', flexShrink: 0 }}
    >
      <Icon name="x" size={14} />
    </button>
  );

  // Generic files have no preview: one row with the name, size, and a download link.
  if (att.kind === 'file') {
    return (
      <div style={{ borderRadius: 14, border: '1px solid var(--line)', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', gap: 11, paddingBlock: 10, paddingInlineStart: 13, paddingInlineEnd: 9 }}>
        <span style={{ width: 38, height: 38, borderRadius: 11, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)', border: '1px solid var(--line)' }}>
          <Icon name="file" size={18} color="var(--ink-2)" />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--ui)', fontSize: 13.5, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {att.name || t('media.attachedFile')}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>
            {fmtBytes(att.bytes)}{att.mime ? ` · ${att.mime}` : ''}
          </div>
        </div>
        {url ? (
          <a
            href={url}
            download={att.name || t('media.attachmentFilename')}
            title={t('media.downloadFile')}
            style={{ width: 30, height: 30, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-ink)', flexShrink: 0 }}
          >
            <Icon name="download" size={16} />
          </a>
        ) : failed ? (
          retryBtn
        ) : (
          <span style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-3)', flexShrink: 0 }}>{t('common.loading')}</span>
        )}
        {deleteBtn}
        {confirming && (
          <ConfirmDeleteDialog att={att} onCancel={() => setConfirming(false)} onConfirm={() => { setConfirming(false); onDelete?.(); }} />
        )}
      </div>
    );
  }

  return (
    <div style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid var(--line)', background: 'var(--surface-2)' }}>
      {url
        ? att.kind === 'audio'
          ? <audio src={url} controls style={{ display: 'block', width: '100%', padding: '10px 11px 4px', boxSizing: 'border-box' }} />
          : att.kind === 'image'
            ? <img
                src={url}
                alt={att.name || t('media.noun.image')}
                onClick={onOpen}
                style={{ display: 'block', width: '100%', maxHeight: 560, objectFit: 'cover', cursor: onOpen ? 'zoom-in' : 'default', background: 'var(--surface)' }}
              />
            : <video src={url} controls playsInline style={{ display: 'block', width: '100%', maxHeight: 420, background: '#1a140e' }} />
        : placeholder}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, paddingBlock: 5, paddingInlineStart: 11, paddingInlineEnd: 7 }}>
        <Icon name={mediaIcon(att.kind)} size={14} color="var(--ink-3)" />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--ink-3)', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {att.name || mediaNoun(att.kind)} · {att.durationMs ? `${fmtDuration(att.durationMs)} · ` : ''}{fmtBytes(att.bytes)}
        </span>
        {deleteBtn}
      </div>
      {(att.kind === 'video' || att.kind === 'audio') && (
        <TranscriptStrip
          transcript={att.transcript}
          onTranscribe={onTranscribe}
          onSave={onSaveTranscript}
          dest={transcribeDest}
        />
      )}
      {confirming && (
        <ConfirmDeleteDialog
          att={att}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onDelete?.();
          }}
        />
      )}
    </div>
  );
}

// ── Image galleries (the inline rendering for uploaded photos) ──

// One thumbnail in a gallery grid: square crop, click to maximize, optional
// confirmed delete. `single` renders the photo at its natural aspect instead.
function GalleryTile({
  att,
  resolve,
  single,
  onOpen,
  onDelete,
}: {
  att: MediaAttachment;
  resolve: MediaResolver;
  single: boolean;
  onOpen?: () => void;
  onDelete?: () => void;
}): VNode {
  const { url, failed, retry } = useMediaUrl(att, resolve);
  const [confirming, setConfirming] = useState(false);

  // Reserve the right footprint before bytes arrive (and for unreachable photos).
  const aspect = single && att.width && att.height ? `${att.width} / ${att.height}` : undefined;
  const frame: Record<string, string | number> = single
    ? { position: 'relative', width: '100%', aspectRatio: aspect ?? '3 / 2', maxHeight: 560, borderRadius: 14, overflow: 'hidden', border: '1px solid var(--line)', background: 'var(--surface-2)' }
    : { position: 'relative', width: '100%', aspectRatio: '1 / 1', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--line)', background: 'var(--surface-2)' };

  return (
    <div style={frame}>
      {url ? (
        <img
          src={url}
          alt={att.name || t('media.noun.image')}
          onClick={onOpen}
          style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover', cursor: onOpen ? 'zoom-in' : 'default' }}
        />
      ) : (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--ink-3)' }}>
          <Icon name="image" size={20} color="var(--ink-3)" />
          {failed ? (
            <button
              onClick={retry}
              style={{ fontFamily: 'var(--ui)', fontSize: 11.5, fontWeight: 600, color: 'var(--accent-ink)', background: 'transparent', border: '1px solid var(--line)', borderRadius: 999, padding: '3px 10px', cursor: 'pointer' }}
            >
              {t('common.retry')}
            </button>
          ) : (
            <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5 }}>{t('common.loading')}</span>
          )}
        </div>
      )}
      {onDelete && (
        <button
          onClick={() => setConfirming(true)}
          title={t('media.delete.confirm', { noun: t('media.noun.image') })}
          style={{ position: 'absolute', top: 7, insetInlineEnd: 7, width: 26, height: 26, borderRadius: 999, border: 'none', background: 'rgba(30,22,16,.55)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#fff' }}
        >
          <Icon name="x" size={13} />
        </button>
      )}
      {confirming && (
        <ConfirmDeleteDialog
          att={att}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onDelete?.();
          }}
        />
      )}
    </div>
  );
}

/**
 * Uploaded photos: a single image renders inline at its natural aspect; several
 * collapse into a thumbnail grid. Clicking a photo maximizes it (the caller's
 * onOpen drives the lightbox, which navigates across the whole entry's images).
 */
export function ImageGallery({
  images,
  resolve,
  onOpen,
  onDelete,
}: {
  images: MediaAttachment[];
  resolve: MediaResolver;
  onOpen?: (att: MediaAttachment) => void;
  /** Called after the user confirmed deleting one photo. */
  onDelete?: (att: MediaAttachment) => void;
}): VNode | null {
  if (images.length === 0) return null;
  const single = images.length === 1;
  // 2 and 4 photos split evenly in two columns; everything else flows in three.
  const cols = single ? 1 : images.length === 2 || images.length === 4 ? 2 : 3;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 7 }}>
      {images.map((att) => (
        <GalleryTile
          key={att.id}
          att={att}
          resolve={resolve}
          single={single}
          onOpen={onOpen ? () => onOpen(att) : undefined}
          onDelete={onDelete ? () => onDelete(att) : undefined}
        />
      ))}
    </div>
  );
}

/**
 * Legacy fallback: entries written before inline media keep their attachments
 * in the entry's attachments array and render after the document. New
 * recordings are inline mediaAttachment nodes and never reach this list.
 */
export function AttachmentList({ entry }: { entry: JournalEntry }): VNode | null {
  const { mediaBlob, updateEntry, removeMedia, aiSettings, transcribeToken } = useAppData();
  const attachments = entry.attachments ?? [];
  if (!attachments.length) return null;
  // Legacy attachments transcribe too; the text lands in the attachments array
  // (their storage), which travels inside the encrypted entry like bodyJson.
  const cfg = transcriptionConfig(aiSettings, transcribeToken);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, margin: '18px 0 6px' }}>
      {attachments.map((att) => (
        <MediaCard
          key={att.id}
          att={att}
          resolve={(a) => mediaBlob(entry.id, a)}
          onDelete={() => {
            updateEntry(entry.id, { attachments: attachments.filter((a) => a.id !== att.id) });
            removeMedia(att.id);
          }}
          transcribeDest={cfg ? transcriptionDestination(cfg) : undefined}
          onSaveTranscript={(text) =>
            updateEntry(entry.id, {
              attachments: attachments.map((a) => (a.id === att.id ? { ...a, transcript: text || undefined } : a)),
            })
          }
          onTranscribe={
            cfg
              ? async () => {
                  const blob = await mediaBlob(entry.id, att);
                  if (!blob) throw new Error(t('media.retryUnavailable'));
                  const text = await transcribe(cfg, blob, { mime: att.mime });
                  updateEntry(entry.id, {
                    attachments: attachments.map((a) => (a.id === att.id ? { ...a, transcript: text } : a)),
                  });
                }
              : undefined
          }
        />
      ))}
    </div>
  );
}
