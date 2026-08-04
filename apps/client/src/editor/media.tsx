// Inline media: block-level atom nodes embedding media cards in the document
// flow. The attachment metadata lives in the node attrs, which serialize into
// bodyJson and therefore travel inside the encrypted entry body (§3) — the
// relay still only ever sees the random media ids.
//
// Two nodes: `mediaAttachment` carries one recording or uploaded file (video,
// audio, generic file), `mediaGallery` carries the uploaded photos of one
// insert — a single image renders inline, several render as a thumbnail grid.
//
// TipTap has no Preact binding, so the node views mount the shared cards into
// their own DOM elements with preact's render(); deletes go through the cards'
// confirmation dialogs before nodes shrink/are removed and the local bytes are
// purged (the handlers' onRemoved).
import { Node, mergeAttributes, type Editor, type JSONContent } from '@tiptap/core';
import { render } from 'preact';
import type { MediaAttachment } from '../sync/engine';
import type { TranscribeDestination } from '../ai/transcribe';
import { MediaCard, ImageGallery, type MediaResolver } from '../ui/Attachments';

export interface MediaNodeHandlers {
  resolve: MediaResolver;
  /** Called after a confirmed delete removed the node — purge local bytes/outbox. */
  onRemoved: (att: MediaAttachment) => void;
  /** Maximize an image in the lightbox (navigates across the entry's images). */
  onOpenImage?: (att: MediaAttachment) => void;
  /** Speech-to-text for a video/audio recording (ai/transcribe.ts). Present only
   *  when a transcription server is configured — presence gates the affordance. */
  transcribe?: (att: MediaAttachment) => Promise<string>;
  /** Where transcription goes — node views can't reach app context, so the
   *  per-use disclosure data rides in with the handlers. */
  transcribeDest?: TranscribeDestination;
}

export const MEDIA_NODE = 'mediaAttachment';
export const GALLERY_NODE = 'mediaGallery';

// Inserting an atom leaves it node-selected, so the very next keystroke would
// REPLACE the fresh attachment. A trailing paragraph puts the cursor after it.

/** Insert a captured recording or uploaded file at the current selection. */
export function insertMediaAttachment(editor: Editor, att: MediaAttachment): void {
  editor
    .chain()
    .focus()
    .insertContent([{ type: MEDIA_NODE, attrs: { ...att } }, { type: 'paragraph' }])
    .run();
}

/** Insert one batch of uploaded photos as a gallery at the current selection. */
export function insertImageGallery(editor: Editor, images: MediaAttachment[]): void {
  if (images.length === 0) return;
  editor
    .chain()
    .focus()
    .insertContent([{ type: GALLERY_NODE, attrs: { images } }, { type: 'paragraph' }])
    .run();
}

// Node attrs round-trip through JSON; coerce defensively back into the shape
// the cards and the sync layer expect.
function nodeAttachment(attrs: Record<string, unknown>): MediaAttachment {
  const kind = attrs.kind;
  return {
    id: String(attrs.id ?? ''),
    kind: kind === 'audio' || kind === 'image' || kind === 'file' ? kind : 'video',
    mime: String(attrs.mime ?? ''),
    bytes: Number(attrs.bytes ?? 0),
    durationMs: typeof attrs.durationMs === 'number' ? attrs.durationMs : undefined,
    name: typeof attrs.name === 'string' && attrs.name ? attrs.name : undefined,
    width: typeof attrs.width === 'number' ? attrs.width : undefined,
    height: typeof attrs.height === 'number' ? attrs.height : undefined,
    createdAt: Number(attrs.createdAt ?? 0),
    transcript: typeof attrs.transcript === 'string' && attrs.transcript ? attrs.transcript : undefined,
  };
}

function galleryImages(attrs: Record<string, unknown>): MediaAttachment[] {
  const raw = Array.isArray(attrs.images) ? (attrs.images as Record<string, unknown>[]) : [];
  return raw.map((img) => nodeAttachment({ ...img, kind: 'image' })).filter((a) => a.id);
}

/** Every image attachment of a doc, in document order — drives lightbox navigation. */
export function docImages(doc: JSONContent): MediaAttachment[] {
  const out: MediaAttachment[] = [];
  const walk = (node: JSONContent): void => {
    if (node.type === GALLERY_NODE && node.attrs) out.push(...galleryImages(node.attrs));
    if (node.type === MEDIA_NODE && node.attrs?.kind === 'image') {
      const att = nodeAttachment(node.attrs);
      if (att.id) out.push(att);
    }
    node.content?.forEach(walk);
  };
  walk(doc);
  return out;
}

// Keep ProseMirror's hands off interactions with the embedded players, images,
// buttons, links, and the confirmation dialogs.
function stopEvent(event: Event): boolean {
  const t = event.target as HTMLElement | null;
  // `textarea` is the transcript editor: without it ProseMirror handles the
  // keystrokes and typing into the box moves the document instead.
  return !!t?.closest('audio, video, img, a, button, textarea, [role="dialog"]');
}

export function mediaAttachmentNode(handlers: MediaNodeHandlers): Node {
  return Node.create({
    name: MEDIA_NODE,
    group: 'block',
    atom: true,
    draggable: true,
    addAttributes() {
      return {
        id: { default: '' },
        kind: { default: 'video' },
        mime: { default: '' },
        bytes: { default: 0 },
        durationMs: { default: null },
        name: { default: null },
        width: { default: null },
        height: { default: null },
        createdAt: { default: 0 },
        transcript: { default: null },
      };
    },
    parseHTML() {
      return [{ tag: 'div[data-media-attachment]' }];
    },
    renderHTML({ HTMLAttributes }) {
      return ['div', mergeAttributes(HTMLAttributes, { 'data-media-attachment': '' })];
    },
    addNodeView() {
      return ({ node, editor, getPos }) => {
        const dom = document.createElement('div');
        dom.className = 'mneme-media-node';
        dom.contentEditable = 'false';
        const att = nodeAttachment(node.attrs);
        // Runs only after the user confirmed in the card's dialog.
        const onDelete = (): void => {
          const pos = getPos();
          if (typeof pos !== 'number') return;
          editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
          handlers.onRemoved(att);
        };
        // Write a transcript into the node attrs — from the doc's CURRENT node
        // at that position, not the captured one, so a concurrent attr change
        // isn't resurrected. Empty text clears the attr (the card then offers
        // to transcribe again).
        const writeTranscript = (text: string): void => {
          const pos = getPos();
          if (typeof pos !== 'number') return;
          const cur = editor.state.doc.nodeAt(pos);
          if (!cur || cur.type.name !== MEDIA_NODE || cur.attrs.id !== att.id) return;
          editor.view.dispatch(
            editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, transcript: text || null }),
          );
        };
        const isRecording = att.kind === 'video' || att.kind === 'audio';
        const onTranscribe =
          handlers.transcribe && isRecording
            ? async (): Promise<void> => {
                writeTranscript(await handlers.transcribe!(att));
              }
            : undefined;
        render(
          <MediaCard
            att={att}
            resolve={handlers.resolve}
            onDelete={editor.isEditable ? onDelete : undefined}
            onOpen={att.kind === 'image' && handlers.onOpenImage ? () => handlers.onOpenImage?.(att) : undefined}
            onTranscribe={editor.isEditable ? onTranscribe : undefined}
            onSaveTranscript={editor.isEditable && isRecording ? writeTranscript : undefined}
            transcribeDest={handlers.transcribeDest}
          />,
          dom,
        );
        return {
          dom,
          stopEvent,
          destroy: () => render(null, dom),
        };
      };
    },
  });
}

export function mediaGalleryNode(handlers: MediaNodeHandlers): Node {
  return Node.create({
    name: GALLERY_NODE,
    group: 'block',
    atom: true,
    draggable: true,
    addAttributes() {
      return {
        images: { default: [] },
      };
    },
    parseHTML() {
      return [{ tag: 'div[data-media-gallery]' }];
    },
    renderHTML({ HTMLAttributes }) {
      return ['div', mergeAttributes(HTMLAttributes, { 'data-media-gallery': '' })];
    },
    addNodeView() {
      return ({ node, editor, getPos }) => {
        const dom = document.createElement('div');
        dom.className = 'mneme-media-node';
        dom.contentEditable = 'false';
        // Deleting one photo shrinks the gallery in place; deleting the last
        // one removes the node. Runs only after the confirmation dialog.
        const renderGallery = (current: typeof node): void => {
          const images = galleryImages(current.attrs);
          const onDelete = (att: MediaAttachment): void => {
            const pos = getPos();
            if (typeof pos !== 'number') return;
            const remaining = images.filter((i) => i.id !== att.id);
            if (remaining.length > 0) {
              const tr = editor.state.tr.setNodeMarkup(pos, undefined, { images: remaining });
              editor.view.dispatch(tr);
            } else {
              editor.chain().focus().deleteRange({ from: pos, to: pos + current.nodeSize }).run();
            }
            handlers.onRemoved(att);
          };
          render(
            <ImageGallery
              images={images}
              resolve={handlers.resolve}
              onOpen={handlers.onOpenImage}
              onDelete={editor.isEditable ? onDelete : undefined}
            />,
            dom,
          );
        };
        renderGallery(node);
        return {
          dom,
          stopEvent,
          update: (updated) => {
            if (updated.type.name !== GALLERY_NODE) return false;
            renderGallery(updated as typeof node);
            return true;
          },
          destroy: () => render(null, dom),
        };
      };
    },
  });
}
