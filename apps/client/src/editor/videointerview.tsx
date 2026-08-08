// Video interview: a block-level atom node holding one guided on-camera session
// — the planned questions, the answer clip recorded for each, and (once the user
// asks for it) the single stitched film.
//
// Like the media and location nodes, everything lives in the node attrs and
// therefore serializes into bodyJson, so it travels inside the encrypted entry
// body (§3): the question texts never reach the relay, which only ever sees the
// random media ids and the opaque chunks.
//
// Questions and clips are PAIRED in one `cards` array rather than kept as two
// parallel lists — a retake or a skip cannot desynchronise them, and a null clip
// *is* "skipped". The clips and the film are referenced only from here, so they
// never surface in the lightbox or the legacy attachment list — but
// docMediaIds (editor/doc.ts) counts every one of them so deleting the entry
// purges them locally and on the relay.
import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import { render, type VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t, tp, fmtNumber } from '../i18n';
import type { MediaAttachment } from '../sync/engine';
import { toAiError } from '../ai/types';
import type { TranscribeDestination } from '../ai/transcribe';
import { watchTranscribeRun, type TranscribeRunStatus } from '../ai/transcribeRuns';
import { watchRenderProgress, type RenderProgress } from '../video/film';
import { TranscriptStrip, useMediaUrl, type MediaResolver } from '../ui/Attachments';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Icon } from '../ui/Icon';
import {
  VIDEO_INTERVIEW_NODE,
  coerceVideoInterview,
  isAnswered,
  isFilmStale,
  videoInterviewAttachments,
  type VideoInterviewData,
} from './videointerviewData';

// The shapes and pure helpers live in ./videointerviewData (no Preact imports,
// so editor/doc.ts can use them without a cycle); re-export for callers that
// only reach for the node module.
export * from './videointerviewData';

export interface VideoInterviewHandlers {
  resolve: MediaResolver;
  /** Called per attachment after a confirmed delete — purge bytes local + relay. */
  onRemoved: (att: MediaAttachment) => void;
  /** Open the render dialog for this session; omit to hide the render affordance. */
  onRender?: (data: VideoInterviewData) => void;
  /** Speech-to-text for one answer clip (ai/transcribe.ts). Present only when a
   *  transcription server is configured — presence gates the affordance.
   *  `language` is the session's spoken language (ISO-639-1); omitted means
   *  auto-detect, which is what pre-picker sessions carry. */
  transcribe?: (att: MediaAttachment, language?: string) => Promise<string>;
  /** Where transcription goes — drives the non-local per-use confirm. */
  transcribeDest?: TranscribeDestination;
}

// Inserting an atom leaves it node-selected; a trailing paragraph parks the cursor after it.
/** Insert a video-interview card at the current selection. */
export function insertVideoInterview(editor: Editor, data: VideoInterviewData): void {
  editor
    .chain()
    .focus()
    .insertContent([{ type: VIDEO_INTERVIEW_NODE, attrs: { ...data } }, { type: 'paragraph' }])
    .run();
}

// One answer clip's player, lazily resolved. A clip recorded on another device
// downloads on first view; until then (or on failure) the row offers a retry.
function ClipPlayer({ att, resolve }: { att: MediaAttachment; resolve: MediaResolver }): VNode {
  const { url, failed, retry } = useMediaUrl(att, resolve);
  return (
    <div style={{ borderRadius: 10, overflow: 'hidden', background: 'var(--surface)', border: '1px solid var(--line)' }}>
      {url ? (
        <video src={url} controls playsInline style={{ display: 'block', width: '100%', maxHeight: 320, background: '#1a140e' }} />
      ) : (
        <div style={{ height: 78, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, color: 'var(--ink-3)' }}>
          <Icon name="video" size={17} color="var(--ink-3)" />
          {failed ? (
            <button
              onClick={retry}
              style={{ fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 600, color: 'var(--accent-ink)', background: 'transparent', border: '1px solid var(--line)', borderRadius: 999, padding: '3px 10px', cursor: 'pointer' }}
            >
              {t('editorx.videoInterview.retry')}
            </button>
          ) : (
            <span style={{ fontFamily: 'var(--ui)', fontSize: 12 }}>{t('editorx.videoInterview.loadingClip')}</span>
          )}
        </div>
      )}
    </div>
  );
}

/** The card: the film (once rendered), then every question with its answer. */
export function VideoInterviewCardView({
  data,
  resolve,
  onRender,
  onDelete,
  onDropClips,
  onTranscribe,
  onSaveTranscript,
  transcribeDest,
}: {
  data: VideoInterviewData;
  resolve: MediaResolver;
  /** Omit to hide the render affordance (read-only contexts). */
  onRender?: () => void;
  /** Called after the user confirmed; omit to hide the delete affordance. */
  onDelete?: () => void;
  /** Called after the user confirmed dropping the answer clips, keeping the film. */
  onDropClips?: () => void;
  /** Transcribe every untranscribed answer clip; transcripts land per card.
   *  Reports per-clip counts through `onProgress` for the running label. */
  onTranscribe?: (onProgress?: (s: TranscribeRunStatus) => void) => Promise<void>;
  /** Persist a hand-edited transcript for one answer ('' clears it). */
  onSaveTranscript?: (cardIndex: number, text: string) => void;
  /** Where transcription goes — non-local destinations confirm first. */
  transcribeDest?: TranscribeDestination;
}): VNode {
  const [confirming, setConfirming] = useState(false);
  const [droppingClips, setDroppingClips] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [confirmingTranscribe, setConfirmingTranscribe] = useState(false);
  const [transcribeError, setTranscribeError] = useState('');
  // Per-clip counts of the card's own batch run ("Transcribe answers").
  const [batch, setBatch] = useState<TranscribeRunStatus | null>(null);
  // A detached auto-transcribe run started by the interview sheet (which is
  // gone by now) — followed through the run registry so this card can show it.
  const [detachedRun, setDetachedRun] = useState<TranscribeRunStatus | null>(null);
  // A film render for this session, whoever started it — the dialog may be
  // closed, the encode keeps going, and this bar is what says so.
  const [filmProgress, setFilmProgress] = useState<RenderProgress | null>(null);
  useEffect(() => watchTranscribeRun(data.sessionId, setDetachedRun), [data.sessionId]);
  useEffect(() => watchRenderProgress(data.sessionId, setFilmProgress), [data.sessionId]);
  // Two different counts: `answered` is what the header claims (an answer that
  // outlived its dropped source clip still counts), `clipCount` is what the
  // render/drop/delete affordances need (actual bytes present).
  const answered = data.cards.filter(isAnswered).length;
  const clipCount = data.cards.filter((c) => c.clip).length;
  const untranscribed = data.cards.filter((c) => c.clip && !c.transcript).length;
  const stale = isFilmStale(data);

  const runTranscribe = async (): Promise<void> => {
    if (transcribing) return;
    setTranscribing(true);
    setTranscribeError('');
    try {
      await onTranscribe?.(setBatch);
    } catch (e) {
      const err = toAiError(e);
      setTranscribeError(
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
      setTranscribing(false);
      setBatch(null);
    }
  };

  // Whichever transcription run is live — the card's own batch or a detached
  // auto-transcribe — feeds one progress line.
  const transcribeRun = batch ?? detachedRun;
  const filmPct = filmProgress ? Math.round(filmProgress.ratio * 100) : 0;

  return (
    <div style={{ borderRadius: 14, overflow: 'hidden', border: '1px solid var(--line)', background: 'var(--surface-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 11px', borderBottom: '1px solid var(--line)' }}>
        <Icon name="film" size={16} color="var(--accent-ink)" />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontFamily: 'var(--ui)', fontSize: 13, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {data.typeName || t('editorx.videoInterview.title')}
          </span>
          <span style={{ display: 'block', fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--ink-3)' }}>
            {tp('editorx.videoInterview.questions', data.cards.length)}
            {' · '}
            {t('editorx.videoInterview.answered', { n: String(answered), total: String(data.cards.length) })}
          </span>
        </span>
        {onDelete && (
          <button
            onClick={() => setConfirming(true)}
            title={t('editorx.videoInterview.delete')}
            style={{ flexShrink: 0, width: 26, height: 26, borderRadius: 999, border: '1px solid var(--line)', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--ink-3)' }}
          >
            <Icon name="x" size={13} color="var(--ink-3)" />
          </button>
        )}
      </div>

      {(data.film || onRender || (onTranscribe && untranscribed > 0) || transcribeError || filmProgress || transcribeRun) && (
        <div style={{ padding: '11px 11px 0' }}>
          {data.film && (
            <>
              <span style={{ display: 'block', fontFamily: 'var(--ui)', fontSize: 11, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 6 }}>
                {t('editorx.videoInterview.film')}
              </span>
              <ClipPlayer att={data.film} resolve={resolve} />
            </>
          )}
          {stale && (
            <p style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--ink-3)', margin: '7px 0 0' }}>
              {t('media.film.stale')}
            </p>
          )}
          {/* A running render, whoever started it — the dialog may be long
              closed. The finished film lands on this card by itself (the
              editor folds attachFilm's write-back into the live doc). */}
          {filmProgress && (
            <div style={{ marginTop: data.film ? 8 : 0 }}>
              <p style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-2)', margin: '0 0 5px' }}>
                {t('media.film.rendering', { pct: fmtNumber(filmPct) })}
              </p>
              <div style={{ height: 5, borderRadius: 999, background: 'var(--surface)', border: '1px solid var(--line)', overflow: 'hidden' }}>
                <div style={{ width: `${filmPct}%`, height: '100%', background: 'var(--accent)', transition: 'width .3s ease' }} />
              </div>
            </div>
          )}
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: data.film || filmProgress ? 8 : 0 }}>
            {onRender && clipCount > 0 && !filmProgress && (
              <button
                onClick={onRender}
                style={{ fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--accent-ink)', background: 'transparent', border: '1px solid var(--line)', borderRadius: 999, padding: '5px 13px', cursor: 'pointer' }}
              >
                {data.film ? t('media.film.rerender') : t('media.film.render')}
              </button>
            )}
            {/* The vault now carries every answer twice — this is the lever for
                that, and for a relay with a per-owner quota. */}
            {onDropClips && data.film && clipCount > 0 && (
              <button
                onClick={() => setDroppingClips(true)}
                style={{ fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--ink-3)', background: 'transparent', border: '1px solid var(--line)', borderRadius: 999, padding: '5px 13px', cursor: 'pointer' }}
              >
                {t('media.film.deleteClips')}
              </button>
            )}
            {onTranscribe && untranscribed > 0 && !transcribeRun && (
              <button
                onClick={() => {
                  if (transcribeDest && !transcribeDest.local) setConfirmingTranscribe(true);
                  else void runTranscribe();
                }}
                disabled={transcribing}
                style={{ fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--accent-ink)', background: 'transparent', border: '1px solid var(--line)', borderRadius: 999, padding: '5px 13px', cursor: transcribing ? 'default' : 'pointer', opacity: transcribing ? 0.6 : 1 }}
              >
                {transcribing ? t('media.transcribe.busy') : t('media.transcribe.answers')}
              </button>
            )}
          </span>
          {/* One progress line for either kind of run; each finished answer
              also lands visibly as its transcript strip below. */}
          {transcribeRun && (
            <p style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-2)', margin: '7px 0 0' }}>
              <span className="mneme-busy-dot" />
              {t('media.transcribe.busyCount', { done: fmtNumber(transcribeRun.done), total: fmtNumber(transcribeRun.total) })}
            </p>
          )}
          {transcribeError && (
            <p style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--accent-ink)', margin: '7px 0 0' }}>{transcribeError}</p>
          )}
        </div>
      )}

      <div style={{ padding: 11, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {data.cards.map((card, i) => (
          <div key={i}>
            <p style={{ fontFamily: 'var(--serif)', fontSize: 14.5, lineHeight: 1.45, color: 'var(--ink)', margin: '0 0 6px' }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', marginInlineEnd: 7 }}>{i + 1}</span>
              {card.q}
            </p>
            {card.clip ? (
              <ClipPlayer att={card.clip} resolve={resolve} />
            ) : (
              <span style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-3)', fontStyle: 'italic' }}>
                {isAnswered(card) ? t('editorx.videoInterview.clipRemoved') : t('editorx.videoInterview.notRecorded')}
              </span>
            )}
            {/* The answer's transcript — kept even after the source clips were
                dropped, since it is the searchable text of this answer. */}
            {card.transcript && (
              <TranscriptStrip
                transcript={card.transcript}
                onSave={onSaveTranscript ? (text) => onSaveTranscript(i, text) : undefined}
              />
            )}
          </div>
        ))}
      </div>

      {confirming && (
        <ConfirmDialog
          icon="film"
          title={t('editorx.videoInterview.confirmTitle')}
          confirmLabel={t('editorx.videoInterview.delete')}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onDelete?.();
          }}
        >
          {data.film
            ? t('editorx.videoInterview.confirmBody', { count: String(clipCount) })
            : t('editorx.videoInterview.confirmBodyNoFilm', { count: String(clipCount) })}{' '}
          <strong style={{ color: 'var(--ink)' }}>{t('editorx.videoInterview.cannotUndo')}</strong>
        </ConfirmDialog>
      )}

      {droppingClips && (
        <ConfirmDialog
          icon="film"
          title={t('media.film.deleteClipsTitle')}
          confirmLabel={t('media.film.deleteClips')}
          onCancel={() => setDroppingClips(false)}
          onConfirm={() => {
            setDroppingClips(false);
            onDropClips?.();
          }}
        >
          {t('media.film.deleteClipsBody', { count: String(clipCount) })}{' '}
          <strong style={{ color: 'var(--ink)' }}>{t('editorx.videoInterview.cannotUndo')}</strong>
        </ConfirmDialog>
      )}

      {confirmingTranscribe && transcribeDest && (
        <ConfirmDialog
          icon="shield"
          title={t('media.transcribe.confirmTitle')}
          confirmLabel={t('media.transcribe.answers')}
          onCancel={() => setConfirmingTranscribe(false)}
          onConfirm={() => {
            setConfirmingTranscribe(false);
            void runTranscribe();
          }}
        >
          {t('media.transcribe.confirmAnswersBody', { count: String(untranscribed), host: transcribeDest.host })}
        </ConfirmDialog>
      )}
    </div>
  );
}

// Keep ProseMirror's hands off interactions with the players, buttons, and dialog.
function stopEvent(event: Event): boolean {
  const el = event.target as HTMLElement | null;
  // `textarea` is the transcript editor: without it ProseMirror handles the
  // keystrokes and typing into the box moves the document instead.
  return !!el?.closest('video, a, button, textarea, [role="dialog"]');
}

export function videoInterviewNode(handlers: VideoInterviewHandlers): Node {
  return Node.create({
    name: VIDEO_INTERVIEW_NODE,
    group: 'block',
    atom: true,
    draggable: true,
    addAttributes() {
      return {
        sessionId: { default: '' },
        typeName: { default: '' },
        cards: { default: [] },
        film: { default: null },
        renderedAt: { default: null },
      };
    },
    parseHTML() {
      return [{ tag: 'div[data-video-interview]' }];
    },
    renderHTML({ HTMLAttributes }) {
      return ['div', mergeAttributes(HTMLAttributes, { 'data-video-interview': '' })];
    },
    addNodeView() {
      return ({ node, editor, getPos }) => {
        const dom = document.createElement('div');
        dom.className = 'mneme-video-interview-node';
        dom.contentEditable = 'false';

        const draw = (attrs: Record<string, unknown>, size: number): void => {
          const data = coerceVideoInterview(attrs);
          if (!data) {
            render(null, dom);
            return;
          }
          // Runs only after the user confirmed in the card's dialog.
          const onDelete = (): void => {
            const pos = getPos();
            if (typeof pos !== 'number') return;
            editor.chain().focus().deleteRange({ from: pos, to: pos + size }).run();
            for (const att of videoInterviewAttachments(data)) handlers.onRemoved(att);
          };
          // Keep the film and the questions, drop the source recordings: clear
          // the clip refs first so nothing in the document still points at bytes
          // that are about to go, then purge them local + relay.
          const onDropClips = (): void => {
            const pos = getPos();
            if (typeof pos !== 'number') return;
            const clips = data.cards.map((c) => c.clip).filter((c): c is MediaAttachment => !!c);
            editor
              .chain()
              .focus()
              .command(({ tr }) => {
                // `attrs`, not the captured `node` — after an update() the outer
                // node is stale and would resurrect the pre-update attrs.
                tr.setNodeMarkup(pos, undefined, {
                  ...attrs,
                  // Keep the transcripts: they are the searchable text of the
                  // answers and must outlive the bytes being dropped here. The
                  // `dropped` flag keeps an answered question reading as
                  // answered once its clip is gone (here and on other devices).
                  cards: data.cards.map((c) => ({
                    q: c.q,
                    clip: null,
                    transcript: c.transcript,
                    dropped: c.clip ? true : c.dropped,
                  })),
                });
                return true;
              })
              .run();
            for (const att of clips) handlers.onRemoved(att);
          };
          // Transcribe every untranscribed answer, one clip at a time, writing
          // each transcript into the node as it lands (the per-card redraw is
          // the progress display). Attrs are re-read from the doc's current
          // node each round so the writes compose instead of clobbering.
          // Returns false when this node is gone from the doc — the caller's
          // signal to stop (a batch transcription must not keep running for a
          // card nobody can see any more).
          const writeTranscript = (cardIndex: number, text: string): boolean => {
            const pos = getPos();
            if (typeof pos !== 'number') return false;
            const cur = editor.state.doc.nodeAt(pos);
            if (!cur || cur.type.name !== VIDEO_INTERVIEW_NODE || cur.attrs.sessionId !== data.sessionId) return false;
            const cards = (cur.attrs.cards as Record<string, unknown>[]).map((c, j) =>
              // An emptied box clears the transcript rather than storing '' —
              // coerceVideoInterview treats both alike, but a cleared card is
              // what puts it back into the "Transcribe answers" count.
              j === cardIndex ? { ...c, transcript: text || undefined } : c,
            );
            editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, cards }));
            return true;
          };
          const onTranscribe = async (onProgress?: (s: TranscribeRunStatus) => void): Promise<void> => {
            const pending = data.cards.filter((c) => c.clip && !c.transcript).length;
            let done = 0;
            onProgress?.({ done, total: pending });
            for (let i = 0; i < data.cards.length; i++) {
              const card = data.cards[i];
              if (!card.clip || card.transcript) continue;
              // data.lang is the language this session was recorded in; absent
              // on pre-picker sessions, which means auto-detect.
              const text = await handlers.transcribe!(card.clip, data.lang);
              if (!writeTranscript(i, text)) return;
              done++;
              onProgress?.({ done, total: pending });
            }
          };
          render(
            <VideoInterviewCardView
              data={data}
              resolve={handlers.resolve}
              onRender={handlers.onRender ? () => handlers.onRender?.(data) : undefined}
              onDelete={editor.isEditable ? onDelete : undefined}
              onDropClips={editor.isEditable ? onDropClips : undefined}
              onTranscribe={handlers.transcribe && editor.isEditable ? onTranscribe : undefined}
              onSaveTranscript={editor.isEditable ? (i, text) => void writeTranscript(i, text) : undefined}
              transcribeDest={handlers.transcribeDest}
            />,
            dom,
          );
        };

        draw(node.attrs, node.nodeSize);
        return {
          dom,
          stopEvent,
          // A finished render sets the film attr through a transaction; re-draw
          // in place rather than letting ProseMirror rebuild the node view.
          update: (updated) => {
            if (updated.type.name !== VIDEO_INTERVIEW_NODE) return false;
            draw(updated.attrs, updated.nodeSize);
            return true;
          },
          destroy: () => render(null, dom),
        };
      };
    },
  });
}
