// Shared TipTap/ProseMirror document helpers: the extension set the editor uses,
// plus conversions between our stored shapes (bodyJson string, preview bodyText,
// and the design's sample blocks) and ProseMirror JSON. Keeping this in one place
// means the editor, seeding, and previews all agree on the document schema.
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';
import type { Extensions, JSONContent } from '@tiptap/core';
import type { Block } from '../data/sample';
import { mathExtension, type MathHandle } from './math';
import { wikiLinkNode, type WikiLinkHandlers } from './wikilink';
import { ALLOWED_LINK_PROTOCOLS, isSafeHref } from './url';

// lowlight's "common" grammar set (~35 languages); unset code blocks auto-detect.
const lowlight = createLowlight(common);

export const EMPTY_DOC: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };

/** The extension set, shared by every editor instance. Math, tables, and entry
 * links are always in (docs containing them must open everywhere); the optional
 * handles/handlers wire interactivity (click-to-edit, link navigation). */
export function buildExtensions(placeholder: string, math?: MathHandle, wiki?: WikiLinkHandlers): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      codeBlock: false, // replaced by the lowlight-highlighted code block
      // StarterKit bundles the Link mark, which renders <a href>. Its default
      // URL check is sound today, but an XSS-critical control must not depend
      // on an upstream default staying that way: pin the protocol allowlist to
      // ours and validate every URL through the same predicate the Markdown
      // parsers use (./url.ts).
      link: {
        protocols: [...ALLOWED_LINK_PROTOCOLS],
        // Both hooks: `isAllowedUri` gates rendering/commands, `validate`
        // gates autolinking and paste.
        isAllowedUri: (url: string) => isSafeHref(url),
        validate: (url: string) => isSafeHref(url),
        // Nothing in an entry should be able to open a tab with a live
        // `window.opener` handle back into the unlocked app.
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null },
      },
    }),
    CodeBlockLowlight.configure({ lowlight }),
    TableKit.configure({ table: { resizable: true } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder }),
    mathExtension(math),
    wikiLinkNode(wiki),
  ];
}

/** Parse a stored bodyJson string into a ProseMirror doc, falling back to plain text. */
export function parseBody(bodyJson: string | undefined, bodyText: string): JSONContent {
  if (bodyJson) {
    try {
      return JSON.parse(bodyJson) as JSONContent;
    } catch {
      /* fall through to plain text */
    }
  }
  return textToDoc(bodyText);
}

/** Wrap a plain string (one paragraph per line) into a ProseMirror doc. */
export function textToDoc(text: string): JSONContent {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return EMPTY_DOC;
  return {
    type: 'doc',
    content: lines.map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })),
  };
}

/** Flatten a ProseMirror doc to plain text — used for previews and FTS. */
export function docToText(doc: JSONContent): string {
  const out: string[] = [];
  const walk = (node: JSONContent): void => {
    if (node.type === 'text' && node.text) out.push(node.text);
    // Inline media has no text content; give previews/search a small marker.
    if (node.type === 'mediaAttachment') {
      const kind = node.attrs?.kind;
      const name = typeof node.attrs?.name === 'string' && node.attrs.name ? ` ${node.attrs.name}` : '';
      if (kind === 'audio') out.push('🎙 audio');
      else if (kind === 'image') out.push(`🖼 image${name}`);
      else if (kind === 'file') out.push(`📎${name || ' file'}`);
      else out.push('🎬 video');
    }
    if (node.type === 'mediaGallery') {
      const n = Array.isArray(node.attrs?.images) ? node.attrs.images.length : 0;
      out.push(n === 1 ? '🖼 1 photo' : `🖼 ${n} photos`);
    }
    // Math nodes carry their LaTeX source so previews/search can see formulas.
    if ((node.type === 'inlineMath' || node.type === 'blockMath') && typeof node.attrs?.latex === 'string') {
      out.push(node.attrs.latex);
    }
    // Entry links surface their label so previews/search match the link text.
    if (node.type === 'entryLink' && typeof node.attrs?.label === 'string') {
      out.push(`🔗 ${node.attrs.label}`);
    }
    // Location cards surface their place names so previews/search match them.
    if (node.type === 'locationMap') {
      const from = (node.attrs?.from as { label?: unknown } | undefined)?.label;
      const to = (node.attrs?.to as { label?: unknown } | undefined)?.label;
      if (typeof from === 'string') out.push(`📍 ${from}${typeof to === 'string' && to ? ` → ${to}` : ''}`);
    }
    if (node.content) node.content.forEach(walk);
    // Block-level nodes get a separating newline so previews read naturally
    // (inline math and entry links sit mid-sentence, so they stay on their line).
    if (node.type && node.type !== 'text' && node.type !== 'doc' && node.type !== 'inlineMath' && node.type !== 'entryLink') out.push('\n');
  };
  walk(doc);
  return out.join('').replace(/\n{2,}/g, '\n').trim();
}

/** Media ids of every inline media node in a doc — single attachments and gallery images alike. */
export function docMediaIds(doc: JSONContent): string[] {
  const ids: string[] = [];
  const walk = (node: JSONContent): void => {
    if (node.type === 'mediaAttachment' && typeof node.attrs?.id === 'string' && node.attrs.id) {
      ids.push(node.attrs.id);
    }
    if (node.type === 'mediaGallery' && Array.isArray(node.attrs?.images)) {
      for (const img of node.attrs.images as { id?: unknown }[]) {
        if (typeof img?.id === 'string' && img.id) ids.push(img.id);
      }
    }
    // A location card references its frozen map snapshot (and optional photo) as
    // regular media rows — count them so deletion purges them local + relay.
    if (node.type === 'locationMap') {
      for (const m of [node.attrs?.map, node.attrs?.photo] as { id?: unknown }[]) {
        if (typeof m?.id === 'string' && m.id) ids.push(m.id);
      }
    }
    node.content?.forEach(walk);
  };
  walk(doc);
  return ids;
}

/** Entry ids referenced by every entryLink node in a doc — drives backlinks. */
export function docEntryLinks(doc: JSONContent): string[] {
  const ids: string[] = [];
  const walk = (node: JSONContent): void => {
    if (node.type === 'entryLink' && typeof node.attrs?.entryId === 'string' && node.attrs.entryId) {
      ids.push(node.attrs.entryId);
    }
    node.content?.forEach(walk);
  };
  walk(doc);
  return ids;
}

// Strip the inline emphasis markers a model tends to emit; this doc path produces
// plain-text runs only (the schema's bold/italic/code marks aren't populated here).
function stripInline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1')
    .replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .trim();
}

/**
 * Split a leading `# ` title line off an AI-synthesized Markdown draft. The
 * synthesis prompts ask for exactly one level-1 title line followed by the
 * entry body (whose section headings are `## `); the title becomes the entry's
 * title field instead of the date-time default. Returns `title: null` when the
 * draft doesn't start with one (older provider output, model ignoring the
 * instruction) so callers can keep the default-title fallback.
 */
export function splitMarkdownTitle(md: string): { title: string | null; body: string } {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first === -1) return { title: null, body: md };
  const m = /^#\s+(.*)$/.exec(lines[first].trim());
  const title = m ? stripInline(m[1]) : '';
  if (!title) return { title: null, body: md };
  return { title, body: lines.slice(first + 1).join('\n').trim() };
}

/**
 * Parse a small Markdown subset — the shape the AI surfaces emit — into a
 * ProseMirror doc: `#`/`##`/`###` headings (capped at the schema's level 3),
 * `-`/`*` bullet lists, `1.` ordered lists, `>` blockquotes, and blank-line-
 * separated paragraphs. Inline emphasis markers are stripped to plain text.
 * Reused by every AI-written entry (guided interview + freeform draft).
 */
export function markdownToDoc(md: string): JSONContent {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const content: JSONContent[] = [];
  let para: string[] = [];
  let bullets: JSONContent[] = [];
  let ordered: JSONContent[] = [];
  let quote: string[] = [];

  const runs = (s: string): JSONContent[] => (s ? [{ type: 'text', text: s }] : []);
  const item = (s: string): JSONContent => ({ type: 'listItem', content: [{ type: 'paragraph', content: runs(s) }] });
  const flushPara = (): void => {
    if (para.length) content.push({ type: 'paragraph', content: runs(para.join(' ')) });
    para = [];
  };
  const flushBullets = (): void => {
    if (bullets.length) content.push({ type: 'bulletList', content: bullets });
    bullets = [];
  };
  const flushOrdered = (): void => {
    if (ordered.length) content.push({ type: 'orderedList', attrs: { start: 1 }, content: ordered });
    ordered = [];
  };
  const flushQuote = (): void => {
    if (quote.length)
      content.push({ type: 'blockquote', content: quote.map((q) => ({ type: 'paragraph', content: runs(q) })) });
    quote = [];
  };
  const flushAll = (): void => {
    flushPara();
    flushBullets();
    flushOrdered();
    flushQuote();
  };

  for (const raw of lines) {
    const t = raw.trim();
    if (!t) {
      flushAll();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(t);
    const bullet = /^[-*]\s+(.*)$/.exec(t);
    const num = /^\d+[.)]\s+(.*)$/.exec(t);
    const bq = /^>\s?(.*)$/.exec(t);
    if (heading) {
      flushAll();
      content.push({ type: 'heading', attrs: { level: Math.min(3, heading[1].length) }, content: runs(stripInline(heading[2])) });
    } else if (bullet) {
      flushPara();
      flushOrdered();
      flushQuote();
      bullets.push(item(stripInline(bullet[1])));
    } else if (num) {
      flushPara();
      flushBullets();
      flushQuote();
      ordered.push(item(stripInline(num[1])));
    } else if (bq) {
      flushPara();
      flushBullets();
      flushOrdered();
      quote.push(stripInline(bq[1]));
    } else {
      flushBullets();
      flushOrdered();
      flushQuote();
      para.push(stripInline(t));
    }
  }
  flushAll();
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

/** Convert the design's sample blocks into a ProseMirror doc (for lived-in seed content). */
export function blocksToDoc(blocks: Block[]): JSONContent {
  const content: JSONContent[] = [];
  const checks: JSONContent[] = [];
  const flushChecks = (): void => {
    if (checks.length) {
      content.push({ type: 'taskList', content: checks.splice(0) });
    }
  };
  for (const b of blocks) {
    if (b.type === 'check') {
      checks.push({
        type: 'taskItem',
        attrs: { checked: b.done },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: b.text }] }],
      });
      continue;
    }
    flushChecks();
    if (b.type === 'p') content.push({ type: 'paragraph', content: [{ type: 'text', text: b.text }] });
    else if (b.type === 'h') content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: b.text }] });
    else if (b.type === 'quote') content.push({ type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: b.text }] }] });
    else if (b.type === 'code') content.push({ type: 'codeBlock', attrs: { language: b.lang ?? null }, content: [{ type: 'text', text: b.text }] });
    else if (b.type === 'math') content.push({ type: 'blockMath', attrs: { latex: b.latex } });
    // photo/audio are media (§10 step 5) — represented in the preview only for now.
    else if (b.type === 'photo') content.push({ type: 'paragraph', content: [{ type: 'text', text: `🖼 ${b.caption}` }] });
    else if (b.type === 'audio') content.push({ type: 'paragraph', content: [{ type: 'text', text: `🎙 ${b.label} (${b.dur})` }] });
  }
  flushChecks();
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}
