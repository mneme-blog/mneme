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
import { useState } from 'preact/hooks';
import { t, tp } from '../i18n';
import type { MediaAttachment } from '../sync/engine';
import { toAiError } from '../ai/types';
import type { TranscribeDestination } from '../ai/transcribe';
import { TranscriptStrip, useMediaUrl, type MediaResolver } from '../ui/Attachments';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Icon } from '../ui/Icon';
import {
  VIDEO_INTERVIEW_NODE,
  coerceVideoInterview,
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
   *  transcription server is configured — presence gates the affordance. */
  transcribe?: (att: MediaAttachment) => Promise<string>;
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
  /** Transcribe every untranscribed answer clip; transcripts land per card. */
  onTranscribe?: () => Promise<void>;
  /** Where transcription goes — non-local destinations confirm first. */
  transcribeDest?: TranscribeDestination;
}): VNode {
  const [confirming, setConfirming] = useState(false);
  const [droppingClips, setDroppingClips] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [confirmingTranscribe, setConfirmingTranscribe] = useState(false);
  const [transcribeError, setTranscribeError] = useState('');
  const answered = data.cards.filter((c) => c.clip).length;
  const untranscribed = data.cards.filter((c) => c.clip && !c.transcript).length;
  const stale = isFilmStale(data);
  const clipCount = answered;

  // Transcripts appear under each question as they land (the node redraws per
  // clip), so the running button needs no separate progress counter.
  const runTranscribe = async (): Promise<void> => {
    if (transcribing) return;
    setTranscribing(true);
    setTranscribeError('');
    try {
      await onTranscribe?.();
    } catch (e) {
      const err = toAiError(e);
      setTranscribeError(
        err.hint === 'auth' ? t('assistant.error.keyRejectedShort') : t('media.transcribe.failed', { message: err.message }),
      );
    } finally {
      setTranscribing(false);
    }
  };

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

      {(data.film || onRender || (onTranscribe && untranscribed > 0) || transcribeError) && (
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
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: data.film ? 8 : 0 }}>
            {onRender && answered > 0 && (
              <button
                onClick={onRender}
                style={{ fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--accent-ink)', background: 'transparent', border: '1px solid var(--line)', borderRadius: 999, padding: '5px 13px', cursor: 'pointer' }}
              >
                {data.film ? t('media.film.rerender') : t('media.film.render')}
              </button>
            )}
            {/* The vault now carries every answer twice — this is the lever for
                that, and for a relay with a per-owner quota. */}
            {onDropClips && data.film && answered > 0 && (
              <button
                onClick={() => setDroppingClips(true)}
                style={{ fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--ink-3)', background: 'transparent', border: '1px solid var(--line)', borderRadius: 999, padding: '5px 13px', cursor: 'pointer' }}
              >
                {t('media.film.deleteClips')}
              </button>
            )}
            {onTranscribe && untranscribed > 0 && (
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
                {t('editorx.videoInterview.notRecorded')}
              </span>
            )}
            {/* The answer's transcript — kept even after the source clips were
                dropped, since it is the searchable text of this answer. */}
            {card.transcript && <TranscriptStrip transcript={card.transcript} />}
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
  return !!el?.closest('video, a, button, [role="dialog"]');
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
                  // answers and must outlive the bytes being dropped here.
                  cards: data.cards.map((c) => ({ q: c.q, clip: null, transcript: c.transcript })),
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
          const onTranscribe = async (): Promise<void> => {
            for (let i = 0; i < data.cards.length; i++) {
              const card = data.cards[i];
              if (!card.clip || card.transcript) continue;
              const text = await handlers.transcribe!(card.clip);
              const pos = getPos();
              if (typeof pos !== 'number') return;
              const cur = editor.state.doc.nodeAt(pos);
              if (!cur || cur.type.name !== VIDEO_INTERVIEW_NODE || cur.attrs.sessionId !== data.sessionId) return;
              const cards = (cur.attrs.cards as Record<string, unknown>[]).map((c, j) =>
                j === i ? { ...c, transcript: text } : c,
              );
              editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, cards }));
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
