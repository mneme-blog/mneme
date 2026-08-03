// Mounts a vanilla TipTap (ProseMirror) editor into a Preact-managed element.
// TipTap has no official Preact binding, so we drive the framework-agnostic
// `Editor` directly: create it against a ref'd <div>, force a re-render on each
// transaction so toolbar active-states stay live, and hand updates back out.
import type { RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Editor, type JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { buildExtensions, docToText } from './doc';
import { slashExtension, type SlashCommand, type SlashHandle } from './slash';
import { mediaAttachmentNode, mediaGalleryNode, type MediaNodeHandlers } from './media';
import { locationNode, type LocationNodeHandlers } from './location';
import { videoInterviewNode, type VideoInterviewHandlers } from './videointerview';
import type { MathHandle } from './math';
import { wikiLinkSuggestion, type WikiLinkHandlers } from './wikilink';

export interface RichEditorChange {
  json: string; // serialized ProseMirror doc
  text: string; // flattened plain text (preview / FTS)
}

export function useRichEditor(opts: {
  initial: JSONContent;
  placeholder: string;
  editable?: boolean;
  onChange?: (change: RichEditorChange) => void;
  /** Enables the "/" command palette; the caller renders <SlashMenu handle={...}>. */
  slash?: { handle: SlashHandle; commands: SlashCommand[] };
  /** Enables inline media nodes (required to open docs containing them). */
  media?: MediaNodeHandlers;
  /** Enables the location/map node (required to open docs containing one). */
  location?: LocationNodeHandlers;
  /** Enables the video-interview node (required to open docs containing one). */
  videoInterview?: VideoInterviewHandlers;
  /** Enables click-to-edit on math nodes; the caller renders <MathDialog handle={...}>. */
  math?: MathHandle;
  /** Enables entry links: live titles + click-to-navigate, and (optionally) the
   * "[[" entry picker — the caller renders a <SlashMenu handle={...}> for it. */
  wiki?: {
    handlers: WikiLinkHandlers;
    suggest?: { handle: SlashHandle; items: (query: string) => SlashCommand[] };
  };
  /** Files dropped on / pasted into the editor — the caller runs the upload flow. */
  onFiles?: (files: File[]) => void;
}): { editor: Editor | null; mountRef: RefObject<HTMLDivElement> } {
  const mountRef = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  // Keep the latest onChange/onFiles without re-creating the editor.
  const onChangeRef = useRef(opts.onChange);
  onChangeRef.current = opts.onChange;
  const onFilesRef = useRef(opts.onFiles);
  onFilesRef.current = opts.onFiles;

  // Route dropped/pasted files into the upload flow instead of letting the
  // browser navigate away or paste a filename. Drops first move the cursor to
  // the drop point so the upload's insert lands where the user aimed.
  const takeFiles = (view: EditorView, list: FileList | null | undefined, at?: number): boolean => {
    const files = Array.from(list ?? []);
    if (files.length === 0 || !onFilesRef.current) return false;
    if (typeof at === 'number') {
      const tr = view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(at)));
      view.dispatch(tr);
    }
    onFilesRef.current(files);
    return true;
  };

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const instance = new Editor({
      element: el,
      extensions: [
        ...buildExtensions(opts.placeholder, opts.math, opts.wiki?.handlers),
        ...(opts.slash ? [slashExtension(opts.slash.handle, opts.slash.commands)] : []),
        ...(opts.media ? [mediaAttachmentNode(opts.media), mediaGalleryNode(opts.media)] : []),
        ...(opts.location ? [locationNode(opts.location)] : []),
        ...(opts.videoInterview ? [videoInterviewNode(opts.videoInterview)] : []),
        ...(opts.wiki?.suggest ? [wikiLinkSuggestion(opts.wiki.suggest.handle, opts.wiki.suggest.items)] : []),
      ],
      content: opts.initial,
      editable: opts.editable ?? true,
      editorProps: {
        attributes: { class: 'mneme-prose', spellcheck: 'true' },
        handleDrop: (view, event, _slice, moved) => {
          if (moved) return false; // internal drag of an existing node
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
          return takeFiles(view, event.dataTransfer?.files, pos?.pos);
        },
        handlePaste: (view, event) => takeFiles(view, event.clipboardData?.files),
      },
      onUpdate: ({ editor: ed }) => {
        const json = ed.getJSON();
        onChangeRef.current?.({ json: JSON.stringify(json), text: docToText(json) });
      },
    });
    setEditor(instance);
    return () => {
      instance.destroy();
      setEditor(null);
    };
    // Mount once; callers remount (via key) to load a different document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { editor, mountRef };
}
