import type { VNode } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Editor, JSONContent } from '@tiptap/core';
import { Icon } from '../ui/Icon';
import { SyncBadge, Cover, ConnChip } from '../ui/primitives';
import { LabelField } from '../ui/LabelField';
import { LABELS, type Journal } from '../data/sample';
import { useAppData } from '../state/data';
import type { JournalEntry, MediaAttachment, TemplateRecord } from '../sync/engine';
import { useRichEditor } from '../editor/useRichEditor';
import { insertMediaAttachment, insertImageGallery, docImages } from '../editor/media';
import { insertLocation } from '../editor/location';
import { LocationPicker, type LocationInsert } from '../ui/LocationPicker';
import { EditorToolbar, ModeSegmented } from '../editor/Toolbar';
import { parseBody, docToText, docMediaIds, docEntryLinks } from '../editor/doc';
import { docToMarkdown, markdownToDoc } from '../editor/markdown';
import { buildEntryLinkItems } from '../editor/wikilink';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { buildSlashCommands, createSlashHandle } from '../editor/slash';
import { SlashMenu } from '../editor/SlashMenu';
import { createMathHandle, MathDialog } from '../editor/math';
import { AiActionDialog } from '../ui/AiActionDialog';
import type { AiEditorAction } from '../ai/prompts';
import { transcribe, transcriptionConfig, transcriptionDestination } from '../ai/transcribe';
import { VideoCapture } from '../ui/VideoCapture';
import { AudioCapture } from '../ui/AudioCapture';
import { AttachmentList } from '../ui/Attachments';
import { EntryThumbs, entryImages } from '../ui/EntryThumbs';
import { Lightbox } from '../ui/Lightbox';
import { TemplatesSheet } from '../ui/Templates';
import { EntryDateTime } from '../ui/EntryDateTime';
import { JournalPicker, JournalSheet } from '../ui/JournalPicker';
import { FilmRenderDialog, type FilmRenderTarget } from '../ui/FilmRender';
import type { VideoInterviewData } from '../editor/videointerviewData';
import { t, tp, fmtDate } from '../i18n';
import '../editor/editor.css';

// Compact list date: append the year only when the entry isn't from the current
// year, so recent entries stay clean while older ones aren't ambiguous.
function listDate(d: Date): string {
  return d.getFullYear() === new Date().getFullYear()
    ? fmtDate(d, { month: 'short', day: 'numeric' })
    : fmtDate(d, { month: 'short', day: 'numeric', year: 'numeric' });
}
// The month/year a list separator groups by — entries are bucketed by their
// (displayed) entry date.
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}`;
}
const SAVE_DEBOUNCE_MS = 600;

function countWords(text: string): number {
  const s = text.trim();
  return s ? s.split(/\s+/).length : 0;
}

// Pixel size of an uploaded image, stored in the attachment metadata so layout
// can reserve the right footprint before the bytes resolve.
async function imageSize(blob: Blob): Promise<{ width?: number; height?: number }> {
  try {
    const bmp = await createImageBitmap(blob);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return size;
  } catch {
    return {}; // unsupported format — the gallery falls back to a default aspect
  }
}

// Route an uploaded file to its attachment kind by mime type.
function uploadKind(file: File): MediaAttachment['kind'] {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'file';
}

// ── The editable entry surface: title + TipTap body, autosaving to the relay ──
function EntryEditor({
  entry,
  desk,
  mode,
  onEditorReady,
  onWords,
  onOpenEntry,
}: {
  entry: JournalEntry;
  desk: boolean;
  mode: 'rich' | 'markdown';
  onEditorReady: (e: Editor | null) => void;
  onWords: (n: number) => void;
  onOpenEntry: (id: string) => void;
}): VNode {
  const { entries, journals, updateEntry, addMedia, removeMedia, mediaBlob, aiSettings, transcribeToken } = useAppData();
  const [capturing, setCapturing] = useState<'video' | 'audio' | null>(null);
  // The location composer behind the "/" Location command.
  const [locating, setLocating] = useState(false);
  // The template picker behind the "/" Template command.
  const [pickingTemplate, setPickingTemplate] = useState(false);
  // The confirm-before-insert dialog behind the "/" AI commands.
  const [aiAction, setAiAction] = useState<AiEditorAction | null>(null);
  // Computed once per mount; this component is keyed by entry.id so a different
  // entry remounts it with fresh initial content.
  const initial = useMemo(() => parseBody(entry.bodyJson, entry.bodyText), [entry.id]);

  const title = useRef(entry.title);
  const body = useRef<{ json: string; text: string }>({ json: entry.bodyJson ?? '', text: entry.bodyText });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Local "typed but not yet committed" flag — drives the save indicator the instant
  // you edit, before the debounce hands off to the global outbox.
  const [dirty, setDirty] = useState(false);

  // ── Markdown-source mode (per-entry, session-only; `mode` is owned by the
  // parent and resets to 'rich' on entry switch). While in markdown mode the
  // TipTap editor stays mounted but hidden; the live source is a plain textarea.
  const [mdSource, setMdSource] = useState(''); // seeds the textarea on each entry
  const mdRef = useRef(''); // current textarea text
  // The exact markdown the serializer produced on entry, plus the doc it came
  // from — lets an untouched toggle restore the original JSON verbatim (lossless)
  // instead of round-tripping through the parser.
  const mdOrigin = useRef<{ md: string; json: string } | null>(null);

  // Derive the stored body shape from the current markdown source. Unchanged
  // source short-circuits to the original JSON so nothing is ever re-parsed.
  const bodyFromMarkdown = (): { json: string; text: string } => {
    const md = mdRef.current;
    if (mdOrigin.current && md === mdOrigin.current.md) {
      const json = mdOrigin.current.json;
      try {
        return { json, text: docToText(JSON.parse(json) as JSONContent) };
      } catch {
        /* fall through to a fresh parse */
      }
    }
    const doc = markdownToDoc(md);
    return { json: JSON.stringify(doc), text: docToText(doc) };
  };

  const save = (): void => {
    setDirty(false);
    if (modeRef.current === 'markdown') {
      body.current = bodyFromMarkdown();
      onWords(countWords(body.current.text));
    }
    updateEntry(entry.id, { title: title.current, bodyJson: body.current.json, bodyText: body.current.text });
  };
  // Always flush through the latest closure (the unmount flush fires after the
  // last render, and must see the current mode + markdown edits).
  const saveRef = useRef(save);
  saveRef.current = save;
  const scheduleSave = (): void => {
    setDirty(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveRef.current(), SAVE_DEBOUNCE_MS);
  };

  // Hidden pickers behind the "/" Image and File commands.
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Stable for the lifetime of this mount (the editor mounts once; keyed by entry.id).
  const slashHandle = useMemo(createSlashHandle, []);
  const mathHandle = useMemo(createMathHandle, []);
  const wikiHandle = useMemo(createSlashHandle, []);
  const slashCommands = useMemo(
    () =>
      buildSlashCommands({
        onVideo: () => setCapturing('video'),
        onAudio: () => setCapturing('audio'),
        onImage: () => imageInput.current?.click(),
        onFile: () => fileInput.current?.click(),
        onLocation: () => setLocating(true),
        onTemplate: () => setPickingTemplate(true),
        // The dialog is the handle's listener; pos null means insert at the cursor.
        onMath: (kind) => mathHandle.listener?.({ kind, latex: '', pos: null }),
        // Typing "[[" inserts the trigger text; the suggester takes it from there.
        onLink: () => editorRef.current?.chain().focus().insertContent('[[').run(),
        // Gated at mount (the commands array is fixed for the editor's lifetime):
        // toggling AI on takes effect when the entry is reopened.
        onAi: aiSettings?.enabled ? (action) => setAiAction(action) : undefined,
      }),
    [],
  );

  // Live lookups for entry links — node views and the "[[" picker read through
  // refs so the (stable, created-once) handlers see the current entry set.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const onOpenEntryRef = useRef(onOpenEntry);
  onOpenEntryRef.current = onOpenEntry;
  const wiki = useMemo(
    () => ({
      handlers: {
        resolveTitle: (id: string) => {
          const target = entriesRef.current.find((x) => x.id === id && !x.deleted);
          return target ? target.title || t('common.untitled') : null;
        },
        onOpen: (id: string) => {
          if (entriesRef.current.some((x) => x.id === id && !x.deleted)) onOpenEntryRef.current(id);
        },
      },
      suggest: {
        handle: wikiHandle,
        items: (query: string) => buildEntryLinkItems(entriesRef.current, entry.id, query),
      },
    }),
    [],
  );

  // Entries whose body links here — recomputed as entries sync in.
  const backlinks = useMemo(() => {
    const out: JournalEntry[] = [];
    for (const e of entries) {
      if (e.deleted || e.id === entry.id || !e.bodyJson) continue;
      try {
        if (docEntryLinks(JSON.parse(e.bodyJson) as JSONContent).includes(entry.id)) out.push(e);
      } catch {
        /* unparseable body — skip */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }, [entries, entry.id]);

  // Maximized image view: every image of the entry in document order, so ←/→
  // steps through the whole entry. Opened through a ref because the (stable)
  // media handlers are created before the editor instance exists.
  const [lightbox, setLightbox] = useState<{ items: MediaAttachment[]; index: number } | null>(null);
  const openImageRef = useRef<(att: MediaAttachment) => void>(() => undefined);

  // Stable per mount (keyed by entry.id): how inline media nodes get their
  // bytes, how a confirmed delete purges them, how an image maximizes, and —
  // when a transcription server is configured — how a recording turns into
  // text. Like the slash AI commands, the transcribe affordance is gated at
  // editor mount; the settings read through a ref so the request itself always
  // uses the current config.
  const aiSettingsRef = useRef(aiSettings);
  aiSettingsRef.current = aiSettings;
  const mediaHandlers = useMemo(
    () => ({
      resolve: (att: MediaAttachment) => mediaBlob(entry.id, att),
      onRemoved: (att: MediaAttachment) => removeMedia(att.id),
      onOpenImage: (att: MediaAttachment) => openImageRef.current(att),
      // `language` is passed only by the video-interview card, which knows the
      // language its session was recorded in. A lone recording stays on
      // auto-detect: an arbitrary upload has nothing to constrain it with, and
      // a wrong constraint yields confident nonsense rather than an error.
      transcribe: transcriptionConfig(aiSettings, transcribeToken)
        ? async (att: MediaAttachment, language?: string): Promise<string> => {
            const cfg = transcriptionConfig(aiSettingsRef.current, transcribeToken);
            if (!cfg) throw new Error(t('media.transcribe.notConfigured'));
            const blob = await mediaBlob(entry.id, att);
            if (!blob) throw new Error(t('media.retryUnavailable'));
            return transcribe(cfg, blob, { mime: att.mime, language });
          }
        : undefined,
      transcribeDest: (() => {
        const cfg = transcriptionConfig(aiSettings, transcribeToken);
        return cfg ? transcriptionDestination(cfg) : undefined;
      })(),
    }),
    [],
  );

  // Stitching a video interview into one film. The dialog only starts and
  // watches the render — video/film.ts owns it, so closing the editor mid-encode
  // doesn't cancel it and the result still lands via attachFilm.
  const [filmTarget, setFilmTarget] = useState<FilmRenderTarget | null>(null);
  const videoInterviewHandlers = useMemo(
    () => ({
      ...mediaHandlers,
      onRender: (data: VideoInterviewData) => setFilmTarget({ entryId: entry.id, data }),
    }),
    [mediaHandlers],
  );

  // The editor instance, reachable from callbacks created before it exists.
  const editorRef = useRef<Editor | null>(null);
  // Latest mode, read by the (stable) save closure.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Store the uploads, then embed them in the document at the cursor; the
  // entry update rides the normal autosave of the changed document. Images
  // picked together land as one gallery; everything else as its own card.
  const uploadFiles = async (files: File[]): Promise<void> => {
    const ed = editorRef.current;
    const images: MediaAttachment[] = [];
    for (const f of files.filter((f) => uploadKind(f) === 'image')) {
      const att = await addMedia(entry.id, 'image', f, { name: f.name, ...(await imageSize(f)) });
      if (att) images.push(att);
    }
    if (images.length && ed) insertImageGallery(ed, images);
    for (const f of files.filter((f) => uploadKind(f) !== 'image')) {
      const att = await addMedia(entry.id, uploadKind(f), f, { name: f.name });
      if (att && ed) insertMediaAttachment(ed, att);
    }
  };

  const { editor, mountRef } = useRichEditor({
    initial,
    placeholder: t('editor.bodyPlaceholder'),
    slash: { handle: slashHandle, commands: slashCommands },
    media: mediaHandlers,
    location: mediaHandlers,
    videoInterview: videoInterviewHandlers,
    math: mathHandle,
    wiki,
    onFiles: (files) => void uploadFiles(files),
    onChange: (c) => {
      body.current = c;
      onWords(countWords(c.text));
      scheduleSave();
    },
  });
  editorRef.current = editor;
  openImageRef.current = (att) => {
    const items = editor ? docImages(editor.getJSON()) : [];
    const index = items.findIndex((i) => i.id === att.id);
    setLightbox(index >= 0 ? { items, index } : { items: [att], index: 0 });
  };

  // Fold out-of-editor write-backs into the LIVE document. A film render or a
  // detached auto-transcription finishes via attachFilm/attachTranscript, which
  // write the STORED entry — but this editor was seeded once at mount and never
  // re-reads bodyJson, so the result used to appear only after closing and
  // reopening the entry. Whenever the stored body changes, copy exactly the
  // fields those writers own — film, renderedAt, and per-card transcripts,
  // addressed by sessionId — into the matching live nodes. Nothing else is
  // touched, so live typing can't be clobbered; transcripts only fill holes
  // (a hand-edited one in the live doc wins over a late write-back).
  useEffect(() => {
    if (!editor) return;
    let stored: JSONContent;
    try {
      stored = parseBody(entry.bodyJson, entry.bodyText);
    } catch {
      return;
    }
    const bySession = new Map<string, { film: unknown; renderedAt: unknown; transcripts: (string | undefined)[] }>();
    const walk = (node: JSONContent): void => {
      if (node.type === 'videoInterview' && typeof node.attrs?.sessionId === 'string' && node.attrs.sessionId) {
        const cards = Array.isArray(node.attrs.cards) ? (node.attrs.cards as { transcript?: unknown }[]) : [];
        bySession.set(node.attrs.sessionId, {
          film: node.attrs.film ?? null,
          renderedAt: node.attrs.renderedAt ?? null,
          transcripts: cards.map((c) => (typeof c?.transcript === 'string' && c.transcript ? c.transcript : undefined)),
        });
      }
      node.content?.forEach(walk);
    };
    walk(stored);
    if (bySession.size === 0) return;

    let tr = editor.state.tr;
    let changed = false;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'videoInterview') return;
      const s = bySession.get(node.attrs.sessionId as string);
      if (!s) return;
      const liveFilmId = (node.attrs.film as { id?: unknown } | null)?.id ?? null;
      const storedFilmId = (s.film as { id?: unknown } | null)?.id ?? null;
      const filmChanged = storedFilmId !== null && (liveFilmId !== storedFilmId || node.attrs.renderedAt !== s.renderedAt);
      const liveCards = Array.isArray(node.attrs.cards) ? (node.attrs.cards as Record<string, unknown>[]) : [];
      let cardsChanged = false;
      const mergedCards = liveCards.map((c, i) => {
        const incoming = s.transcripts[i];
        if (!incoming || (typeof c.transcript === 'string' && c.transcript)) return c;
        cardsChanged = true;
        return { ...c, transcript: incoming };
      });
      if (!filmChanged && !cardsChanged) return;
      tr = tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        ...(filmChanged ? { film: s.film, renderedAt: s.renderedAt } : {}),
        ...(cardsChanged ? { cards: mergedCards } : {}),
      });
      changed = true;
    });
    if (changed) editor.view.dispatch(tr);
  }, [editor, entry.bodyJson]);

  // Store the recording, then embed it in the document at the cursor.
  const attach = async (kind: MediaAttachment['kind'], blob: Blob, durationMs: number): Promise<void> => {
    const att = await addMedia(entry.id, kind, blob, { durationMs });
    if (att && editor) insertMediaAttachment(editor, att);
  };

  // Store the frozen map snapshot (+ optional travel photo) as media, then embed
  // the location card at the cursor. The map render already happened in the
  // dialog; here we only persist the bytes and write the node.
  const addLocation = async (data: LocationInsert): Promise<void> => {
    const mapAtt = await addMedia(entry.id, 'image', data.map.blob, { name: 'map', width: data.map.width, height: data.map.height });
    if (!mapAtt) return;
    const photoAtt = data.photo
      ? await addMedia(entry.id, 'image', data.photo, { name: data.photo.name, ...(await imageSize(data.photo)) })
      : null;
    if (editor) insertLocation(editor, { from: data.from, to: data.to, zoom: data.zoom, map: mapAtt, photo: photoAtt });
  };

  // Drop the chosen template's blocks in at the cursor (the "/" Template
  // command already removed the slash range before opening the picker).
  const insertTemplate = (tpl: TemplateRecord): void => {
    setPickingTemplate(false);
    const ed = editorRef.current;
    if (!ed) return;
    try {
      const doc = tpl.bodyJson ? (JSON.parse(tpl.bodyJson) as JSONContent) : null;
      if (doc?.content?.length) ed.chain().focus().insertContent(doc.content).run();
    } catch {
      /* unreadable body — insert nothing rather than garbage */
    }
  };

  // Pickers re-fire change even for the same selection (value reset below).
  const onPicked = (ev: Event): void => {
    const el = ev.target as HTMLInputElement;
    const files = Array.from(el.files ?? []);
    el.value = '';
    if (files.length) void uploadFiles(files);
  };

  useEffect(() => {
    onEditorReady(editor);
    onWords(countWords(body.current.text));
    // Without the cleanup, the parent keeps a DESTROYED TipTap instance when
    // the last EntryEditor unmounts (entry deleted → empty state) and the
    // still-rendered toolbar dispatches commands into it.
    return () => onEditorReady(null);
  }, [editor]);

  // Hand off whenever the parent flips the mode. Rich→markdown serializes the
  // current doc into the textarea (remembering it for the lossless restore);
  // markdown→rich parses the (possibly edited) source back into the editor.
  const prevMode = useRef(mode);
  useEffect(() => {
    if (mode === prevMode.current) return;
    prevMode.current = mode;
    const ed = editorRef.current;
    if (mode === 'markdown') {
      const json = ed ? (ed.getJSON() as JSONContent) : initial;
      const md = docToMarkdown(json);
      mdOrigin.current = { md, json: JSON.stringify(json) };
      mdRef.current = md;
      setMdSource(md);
    } else {
      const next = bodyFromMarkdown();
      body.current = next;
      try {
        ed?.commands.setContent(JSON.parse(next.json) as JSONContent, { emitUpdate: false });
      } catch {
        /* parse failure is impossible here — next.json came from us */
      }
      onWords(countWords(next.text));
      scheduleSave();
    }
  }, [mode]);

  // Flush any pending save on unmount (e.g. switching entries or leaving) — via
  // the ref so markdown edits made right before unmount are committed.
  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveRef.current();
      }
    },
    [],
  );

  // Insert generated text at the cursor as paragraphs (the AI dialog confirmed it).
  const insertAiText = (text: string): void => {
    const ed = editorRef.current;
    if (!ed) return;
    const paras: JSONContent[] = text
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] }));
    if (paras.length) ed.chain().focus().insertContent(paras).run();
  };

  // Grow the title textarea to fit its wrapped content (single-line inputs can't wrap).
  const titleEl = useRef<HTMLTextAreaElement | null>(null);
  const fitTitle = (el: HTMLTextAreaElement): void => {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  // Apply an AI-picked title: mirror what typing into the textarea does.
  const applyTitle = (next: string): void => {
    title.current = next;
    if (titleEl.current) {
      titleEl.current.value = next;
      fitTitle(titleEl.current);
    }
    scheduleSave();
  };
  const onTitleInput = (ev: Event): void => {
    const el = ev.target as HTMLTextAreaElement;
    title.current = el.value;
    fitTitle(el);
    scheduleSave();
  };

  // Autocomplete candidates: every label already used across the journal plus
  // the predefined palette, most-used first. Labels live inside entry bodies —
  // there is no separate label registry to query.
  const labelSuggestions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries) {
      if (e.deleted) continue;
      for (const l of e.labels) counts.set(l, (counts.get(l) ?? 0) + 1);
    }
    for (const id of Object.keys(LABELS)) if (!counts.has(id)) counts.set(id, 0);
    return [...counts.keys()].sort(
      (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b),
    );
  }, [entries]);

  return (
    <div style={mode === 'markdown' ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } : undefined}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
        <EntryDateTime value={entry.createdAt} desk={desk} onChange={(ts) => updateEntry(entry.id, { createdAt: ts })} />
        <SyncBadge dirty={dirty} />
      </div>

      <textarea
        ref={(el) => { titleEl.current = el; if (el) fitTitle(el); }}
        defaultValue={entry.title}
        onInput={onTitleInput}
        placeholder={t('common.untitled')}
        rows={1}
        style={{
          width: '100%', border: 'none', outline: 'none', background: 'transparent',
          fontFamily: 'var(--editor-font)', fontSize: desk ? 38 : 30, fontWeight: 600,
          color: 'var(--ink)', lineHeight: 1.15, letterSpacing: 0.2, padding: 0, margin: 0,
          resize: 'none', overflow: 'hidden', display: 'block',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '10px 0 16px', color: 'var(--ink-3)' }}>
        <JournalPicker
          journals={journals}
          currentId={entry.journalId}
          desk={desk}
          onChange={(journalId) => updateEntry(entry.id, { journalId })}
        />
        <LabelField
          labels={entry.labels}
          suggestions={labelSuggestions}
          onChange={(labels) => updateEntry(entry.id, { labels })}
        />
      </div>

      {/* TipTap stays mounted (hidden) in markdown mode so toggling back is instant. */}
      <div ref={mountRef} style={{ display: mode === 'markdown' ? 'none' : 'block' }} />
      {mode === 'markdown' && (
        <textarea
          // Remount per entry so the seed value re-applies when markdown mode opens.
          key={`md-${entry.id}`}
          defaultValue={mdSource}
          onInput={(ev) => {
            mdRef.current = (ev.target as HTMLTextAreaElement).value;
            scheduleSave();
          }}
          spellcheck={false}
          autocapitalize="off"
          autocorrect="off"
          placeholder={t('editor.markdownPlaceholder')}
          style={{
            width: '100%', flex: 1, minHeight: 320, boxSizing: 'border-box', resize: 'none',
            border: '1px solid var(--line)', borderRadius: 12, background: 'var(--surface-2)',
            color: 'var(--ink)', padding: '16px 18px', outline: 'none',
            fontFamily: 'var(--mono)', fontSize: desk ? 14 : 13.5, lineHeight: 1.7,
            whiteSpace: 'pre', overflowWrap: 'normal', overflowX: 'auto', tabSize: 2,
          }}
        />
      )}
      <SlashMenu handle={slashHandle} />
      <SlashMenu handle={wikiHandle} />
      <MathDialog handle={mathHandle} editor={editor} />

      {/* Legacy attachments only (pre-inline entries); new recordings are inline nodes. */}
      <AttachmentList entry={entry} />

      {backlinks.length > 0 && (
        <div style={{ marginTop: 36, paddingTop: 18, borderTop: '1px solid var(--line)' }}>
          <div style={{ fontFamily: 'var(--ui)', fontSize: 11.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 10 }}>
            {t('editor.linkedFrom')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {backlinks.map((e) => {
              const d = new Date(e.createdAt);
              return (
                <button
                  key={e.id}
                  onClick={() => onOpenEntry(e.id)}
                  style={{ display: 'flex', alignItems: 'baseline', gap: 10, width: '100%', textAlign: 'start', cursor: 'pointer', padding: '8px 10px', borderRadius: 10, background: 'transparent', border: 'none' }}
                  onMouseEnter={(ev) => (ev.currentTarget.style.background = 'var(--surface-2)')}
                  onMouseLeave={(ev) => (ev.currentTarget.style.background = 'transparent')}
                >
                  <Icon name="link" size={14} color="var(--ink-3)" style={{ alignSelf: 'center' }} />
                  <span style={{ fontFamily: 'var(--serif)', fontSize: 15.5, fontWeight: 500, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {e.title || t('common.untitled')}
                  </span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', flexShrink: 0 }}>
                    {fmtDate(d, { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {capturing === 'video' && (
        <VideoCapture
          desk={desk}
          onClose={() => setCapturing(null)}
          onCapture={(blob, durationMs) => void attach('video', blob, durationMs)}
        />
      )}

      {filmTarget && <FilmRenderDialog target={filmTarget} onClose={() => setFilmTarget(null)} />}
      {capturing === 'audio' && (
        <AudioCapture
          desk={desk}
          onClose={() => setCapturing(null)}
          onCapture={(blob, durationMs) => void attach('audio', blob, durationMs)}
        />
      )}

      {locating && (
        <LocationPicker
          desk={desk}
          onClose={() => setLocating(false)}
          onInsert={(data) => {
            void addLocation(data);
            setLocating(false);
          }}
        />
      )}

      {pickingTemplate && (
        <TemplatesSheet
          desk={desk}
          useLabel={t('common.insert')}
          onClose={() => setPickingTemplate(false)}
          onUse={insertTemplate}
        />
      )}

      {aiAction && aiSettings && (
        <AiActionDialog
          action={aiAction}
          entryTitle={title.current}
          entryText={body.current.text}
          settings={aiSettings}
          onInsert={insertAiText}
          onPickTitle={applyTitle}
          onClose={() => setAiAction(null)}
        />
      )}

      {/* Hidden pickers for the "/" Image and File commands. */}
      <input ref={imageInput} type="file" accept="image/*" multiple onChange={onPicked} style={{ display: 'none' }} />
      <input ref={fileInput} type="file" multiple onChange={onPicked} style={{ display: 'none' }} />

      {lightbox && (
        <Lightbox
          items={lightbox.items}
          index={lightbox.index}
          resolve={(att) => mediaBlob(entry.id, att)}
          onNavigate={(index) => setLightbox((cur) => (cur ? { ...cur, index } : cur))}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}

// ⋯ menu in the editor header — holds the destructive entry actions. Deleting
// tombstones the entry (syncs to every device) and removes its recordings from
// this device and the relay, so it always confirms first.
function EntryMenu({
  desk,
  entry,
  onDeleted,
  mode,
  onToggleMode,
}: {
  desk: boolean;
  entry: JournalEntry | null;
  onDeleted: () => void;
  /** When provided, the menu hosts the rich-text ⇄ markdown switch (used on mobile,
   * where the segmented control doesn't fit the header). */
  mode?: 'rich' | 'markdown';
  onToggleMode?: () => void;
}): VNode {
  const { deleteEntry, journals, updateEntry } = useAppData();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [moving, setMoving] = useState(false);

  // How many recordings the deletion takes with it (inline nodes + legacy list).
  const mediaCount = useMemo(() => {
    if (!entry) return 0;
    const ids = new Set((entry.attachments ?? []).map((a) => a.id));
    if (entry.bodyJson) {
      try {
        for (const m of docMediaIds(JSON.parse(entry.bodyJson) as JSONContent)) ids.add(m);
      } catch {
        /* unparseable body — count the legacy list only */
      }
    }
    return ids.size;
  }, [entry]);

  const btnStyle = desk
    ? { width: 34, height: 34, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: entry ? 'pointer' : 'default', opacity: entry ? 1 : 0.5 }
    : { width: 36, height: 36, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', cursor: entry ? 'pointer' : 'default', opacity: entry ? 1 : 0.5 };

  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button title={t('editor.entryActions')} disabled={!entry} onClick={() => setOpen((o) => !o)} style={btnStyle}>
        <Icon name="more" size={desk ? 18 : 20} color="var(--ink-2)" />
      </button>
      {open && entry && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 65 }} />
          <div style={{ position: 'absolute', top: 'calc(100% + 6px)', insetInlineEnd: 0, zIndex: 66, minWidth: 196, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12, boxShadow: '0 10px 30px rgba(30,20,12,.18)', padding: 5 }}>
            {onToggleMode && (
              <>
                <button
                  onClick={() => {
                    setOpen(false);
                    onToggleMode();
                  }}
                  style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'start', padding: '9px 11px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'var(--ui)', fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}
                >
                  <Icon name={mode === 'markdown' ? 'feather' : 'code'} size={15} color="var(--ink-2)" />
                  {mode === 'markdown' ? t('editor.editAsRichText') : t('editor.editAsMarkdown')}
                </button>
                <div style={{ height: 1, background: 'var(--line)', margin: '5px 6px' }} />
              </>
            )}
            <button
              onClick={() => {
                setOpen(false);
                setMoving(true);
              }}
              style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'start', padding: '9px 11px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'var(--ui)', fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}
            >
              <Icon name="books" size={15} color="var(--ink-2)" /> {t('editor.moveToJournal')}
            </button>
            <button
              onClick={() => {
                setOpen(false);
                setConfirming(true);
              }}
              style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'start', padding: '9px 11px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'var(--ui)', fontSize: 13.5, fontWeight: 600, color: '#E4573D' }}
            >
              <Icon name="trash" size={15} color="#E4573D" /> {t('editor.deleteEntry')}
            </button>
          </div>
        </>
      )}
      {moving && entry && (
        <JournalSheet
          journals={journals}
          currentId={entry.journalId}
          desk={desk}
          onClose={() => setMoving(false)}
          onPick={(journalId) => {
            setMoving(false);
            if (journalId !== entry.journalId) updateEntry(entry.id, { journalId });
          }}
        />
      )}
      {confirming && entry && (
        <ConfirmDialog
          title={t('editor.delete.confirmTitle')}
          confirmLabel={t('editor.delete.confirmLabel')}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            deleteEntry(entry.id);
            onDeleted();
          }}
        >
          {mediaCount > 0
            ? tp('editor.delete.bodyMedia', mediaCount, { title: entry.title || t('common.untitled') })
            : t('editor.delete.body', { title: entry.title || t('common.untitled') })}{' '}
          <strong style={{ color: 'var(--ink)' }}>{t('editor.delete.cannotUndo')}</strong>
        </ConfirmDialog>
      )}
    </span>
  );
}

export function EditorScreen({
  desk,
  entryId,
  onBack,
  onSelectEntry,
  onNew,
  onDeleted,
}: {
  desk: boolean;
  entryId: string | null;
  onBack: () => void;
  onSelectEntry: (id: string) => void;
  onNew: (journalId?: string) => void;
  /** Mobile delete hand-off: navigate to the journal's entry list. */
  onDeleted: (journalId: string | null) => void;
}): VNode {
  const { entries, journals, mediaThumb } = useAppData();
  const entry = entries.find((e) => e.id === entryId) ?? null;
  // Resolve against the live notebooks from app state — not just the built-in
  // sample seed — otherwise user-created and imported notebooks resolve to
  // undefined, and the header falls back to "Write" with no cover/colour.
  const journalById = (id: string | null | undefined): Journal | undefined =>
    id ? journals.find((j) => j.id === id) : undefined;
  const [editor, setEditor] = useState<Editor | null>(null);
  const [words, setWords] = useState(0);
  // WYSIWYG vs markdown-source editing — per entry, session-only: it resets to
  // rich text whenever a different entry opens (and on reload).
  const [mode, setMode] = useState<'rich' | 'markdown'>('rich');
  useEffect(() => setMode('rich'), [entryId]);
  const toggleMode = (): void => setMode((m) => (m === 'rich' ? 'markdown' : 'rich'));
  // The journal stays the active context even while no entry is open (e.g.
  // right after a delete) — the list, header, and "new entry" keep targeting it.
  const lastJournalId = useRef<string | null>(null);
  if (entry) lastJournalId.current = entry.journalId;
  const journalId = entry?.journalId ?? lastJournalId.current;
  const journal = journalById(journalId);

  // Deleting keeps you inside the journal: desktop opens its next entry (or
  // its scoped empty editor when none remain); mobile returns to its list.
  const handleDeleted = (): void => {
    if (!desk) {
      onDeleted(journalId);
      return;
    }
    const next = entries
      .filter((x) => !x.deleted && x.journalId === journalId && x.id !== entry?.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (next) onSelectEntry(next.id);
  };

  const empty = (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, color: 'var(--ink-3)' }}>
      <Icon name="feather" size={30} color="var(--ink-3)" />
      <span style={{ fontFamily: 'var(--ui)', fontSize: 14 }}>{t('editor.emptyState')}</span>
      <button onClick={() => onNew(journalId ?? undefined)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface)', cursor: 'pointer', color: 'var(--accent-ink)', fontFamily: 'var(--ui)', fontSize: 13.5, fontWeight: 600 }}>
        <Icon name="plus" size={16} color="var(--accent-ink)" /> {t('editor.newEntry')}
      </button>
    </div>
  );

  if (desk) {
    // The entry list is scoped to the active journal (the open entry's, or the
    // last one open — survives a delete); only a fresh editor with no journal
    // context yet falls back to the whole vault.
    const scoped = journalId ? entries.filter((x) => x.journalId === journalId) : entries;
    const list = [...scoped].sort((a, b) => b.createdAt - a.createdAt);
    return (
      <div style={{ height: '100%', display: 'flex', background: 'var(--paper)' }}>
        {/* entry list */}
        <div style={{ width: 312, borderInlineEnd: '1px solid var(--line)', display: 'flex', flexDirection: 'column', background: 'var(--surface-2)' }}>
          <div style={{ padding: '22px 18px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {journal && <Cover journal={journal} w={26} h={34} r={6} />}
              <div>
                <div style={{ fontFamily: 'var(--serif)', fontSize: 17, fontWeight: 500, color: 'var(--ink)' }}>{journal?.name ?? t('editor.write')}</div>
                <div style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--ink-3)' }}>{tp('common.entries', scoped.length)}</div>
              </div>
            </div>
            <button title={t('editor.newEntry')} onClick={() => onNew(journalId ?? undefined)} style={{ width: 34, height: 34, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}><Icon name="plus" size={18} color="var(--accent-ink)" /></button>
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: '0 12px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(() => {
              let lastMonth = '';
              return list.flatMap((x) => {
                const j = journalById(x.journalId);
                const active = x.id === entryId;
                const d = new Date(x.createdAt);
                const images = entryImages(x);
                const key = monthKey(d);
                const sep = key !== lastMonth;
                lastMonth = key;
                return [
                  sep && (
                    <div key={`m-${key}`} style={{ padding: '16px 0 7px', paddingInlineStart: 4, paddingInlineEnd: 13 }}>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: '#786f62', whiteSpace: 'nowrap' }}>
                        {fmtDate(d, { month: 'long', year: 'numeric' })}
                      </span>
                    </div>
                  ),
                  // Hairline between consecutive same-month rows; the month band
                  // heads each new month, so skip it right after one. Tinted from
                  // --ink-3 because --line is invisible on dark skins.
                  !sep && <div key={`d-${x.id}`} style={{ height: 1, background: 'var(--ink-3)', opacity: 0.35, margin: '0 13px' }} />,
                  <button key={x.id} onClick={() => onSelectEntry(x.id)} style={{ textAlign: 'start', cursor: 'pointer', padding: '12px 13px', borderRadius: 12, border: 'none', background: active ? 'var(--surface)' : 'transparent', borderInlineStart: `2.5px solid ${active ? j?.color ?? 'transparent' : 'transparent'}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                      <span style={{ fontFamily: 'var(--serif)', fontSize: 15.5, fontWeight: 500, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.title || t('common.untitled')}</span>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', flexShrink: 0 }}>{listDate(d)}</span>
                    </div>
                    <p style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--ink-2)', margin: '3px 0 0', lineHeight: 1.45, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{x.bodyText}</p>
                    <EntryThumbs images={images} resolve={(att) => mediaThumb(x.id, att)} size={32} />
                  </button>,
                ];
              });
            })()}
          </div>
        </div>

        {/* editor */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 24px', borderBottom: '1px solid var(--line)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
              {entry && <ModeSegmented mode={mode} onChange={setMode} />}
              {mode === 'rich' && <EditorToolbar editor={editor} />}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--ink-3)' }}>{tp('common.words', words)}</span>
              <SyncBadge />
              <EntryMenu desk entry={entry} onDeleted={handleDeleted} />
            </div>
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            {entry ? (
              <div style={{ maxWidth: 660, margin: '0 auto', padding: '40px 32px 80px', boxSizing: 'border-box', ...(mode === 'markdown' ? { minHeight: '100%', display: 'flex', flexDirection: 'column' } : {}) }}>
                <EntryEditor key={entry.id} entry={entry} desk mode={mode} onEditorReady={setEditor} onWords={setWords} onOpenEntry={onSelectEntry} />
              </div>
            ) : (
              empty
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── mobile ──
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--paper)', position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'calc(env(safe-area-inset-top, 0px) + 16px) 14px 10px', flexShrink: 0 }}>
        <button onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: 3, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--accent-ink)', fontFamily: 'var(--ui)', fontSize: 15, fontWeight: 600 }}>
          <Icon name="left" size={22} color="var(--accent-ink)" dirFlip />
        </button>
        <div style={{ textAlign: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
            <span style={{ width: 8, height: 8, borderRadius: 9, background: journal?.color }} />
            <span style={{ fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{journal?.name ?? t('editor.write')}</span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <ConnChip compact />
          <button title={t('editor.newEntry')} onClick={() => onNew(entry?.journalId)} style={{ width: 36, height: 36, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', cursor: 'pointer' }}><Icon name="plus" size={20} color="var(--accent-ink)" /></button>
          <EntryMenu desk={false} entry={entry} onDeleted={handleDeleted} mode={mode} onToggleMode={toggleMode} />
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {entry ? (
          <div style={{ padding: '6px 22px 120px', boxSizing: 'border-box', ...(mode === 'markdown' ? { minHeight: '100%', display: 'flex', flexDirection: 'column' } : {}) }}>
            <EntryEditor key={entry.id} entry={entry} desk={false} mode={mode} onEditorReady={setEditor} onWords={setWords} onOpenEntry={onSelectEntry} />
          </div>
        ) : (
          empty
        )}
      </div>

      {/* floating format toolbar — formatting only; the mode switch lives in the
          ⋯ entry menu, and the bar steps aside entirely in markdown mode. */}
      {entry && mode === 'rich' && (
        <div style={{ position: 'absolute', left: 14, right: 14, bottom: 30, display: 'flex', justifyContent: 'center' }}>
          <EditorToolbar editor={editor} floating />
        </div>
      )}
    </div>
  );
}
