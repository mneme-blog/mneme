// A small Markdown → ProseMirror-JSON converter, scoped to the subset Day One
// emits: headings, bold/italic/code, links, bullet/ordered/task lists, blockquotes,
// fenced code, horizontal rules, and inline image refs (`![](dayone-moment://…)`).
// We don't pull in a general Markdown engine — Day One's output is regular, and a
// focused converter lets us turn its media refs into placeholder nodes the import
// orchestrator replaces with real (encrypted) attachments.
//
// Output nodes match the editor schema in `editor/doc.ts`; media refs are emitted
// as `__dayoneMedia` placeholder nodes carrying the moment identifier + kind.
import type { JSONContent } from '@tiptap/core';
import { safeHref } from '../editor/url';
import type { MomentKind } from './dayone';

/** Placeholder node type for an unresolved Day One media reference. */
export const MEDIA_REF = '__dayoneMedia';

interface InlineResult {
  nodes: JSONContent[];
  /** Image refs pulled out of the inline run, in document order. */
  media: { identifier: string; kind: MomentKind }[];
}

function refFromUrl(url: string): { identifier: string; kind: MomentKind } | null {
  const m = url.match(/^dayone-moment:\/(?:\/)?(?:(video|audio|pdfAttachment)\/)?([A-Za-z0-9-]+)/);
  if (!m) return null;
  const kind: MomentKind = m[1] === 'video' ? 'video' : m[1] === 'audio' ? 'audio' : m[1] === 'pdfAttachment' ? 'file' : 'image';
  return { identifier: m[2], kind };
}

// Parse one inline run (a paragraph's text) into text/hardBreak nodes, carrying
// the active marks downward. Emphasis is matched by nearest closing token —
// good enough for Day One, which rarely nests marks.
function inline(s: string, marks: JSONContent['marks'] = []): InlineResult {
  const nodes: JSONContent[] = [];
  const media: InlineResult['media'] = [];
  let buf = '';
  const flush = (): void => {
    if (buf) { nodes.push(marks && marks.length ? { type: 'text', text: buf, marks } : { type: 'text', text: buf }); buf = ''; }
  };
  const withMark = (m: NonNullable<JSONContent['marks']>[number]): NonNullable<JSONContent['marks']> => [...(marks ?? []), m];

  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { buf += s[i + 1]; i += 2; continue; }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i) { flush(); nodes.push({ type: 'text', text: s.slice(i + 1, j), marks: withMark({ type: 'code' }) }); i = j + 1; continue; }
    }
    if (c === '!' && s[i + 1] === '[') {
      const m = s.slice(i).match(/^!\[[^\]]*\]\(([^)]+)\)/);
      if (m) { const ref = refFromUrl(m[1]); if (ref) { flush(); media.push(ref); } i += m[0].length; continue; }
    }
    if (c === '[') {
      const m = s.slice(i).match(/^\[([^\]]*)\]\(([^)]+)\)/);
      if (m) {
        flush();
        // A Day One export is untrusted input: only allowlisted protocols
        // become a link mark, everything else keeps its text and loses the
        // link (see editor/url.ts).
        const href = safeHref(m[2]);
        const inner = href === null
          ? inline(m[1], marks)
          : inline(m[1], withMark({ type: 'link', attrs: { href } }));
        nodes.push(...inner.nodes); media.push(...inner.media);
        i += m[0].length; continue;
      }
    }
    if (c === '*' || c === '_') {
      const dbl = s.slice(i, i + 2);
      if (dbl === '**' || dbl === '__') {
        const close = s.indexOf(dbl, i + 2);
        if (close > i + 1) { flush(); const inner = inline(s.slice(i + 2, close), withMark({ type: 'bold' })); nodes.push(...inner.nodes); media.push(...inner.media); i = close + 2; continue; }
      } else {
        const close = s.indexOf(c, i + 1);
        if (close > i + 1) { flush(); const inner = inline(s.slice(i + 1, close), withMark({ type: 'italic' })); nodes.push(...inner.nodes); media.push(...inner.media); i = close + 1; continue; }
      }
    }
    if (c === '\n') { flush(); nodes.push({ type: 'hardBreak' }); i++; continue; }
    buf += c; i++;
  }
  flush();
  return { nodes, media };
}

// A paragraph of source text → the paragraph node (when it has text) plus any
// media-ref placeholders it contained, appended after it.
function paragraph(text: string): JSONContent[] {
  const { nodes, media } = inline(text.trim());
  const out: JSONContent[] = [];
  if (nodes.length) out.push({ type: 'paragraph', content: nodes });
  for (const r of media) out.push({ type: MEDIA_REF, attrs: { identifier: r.identifier, kind: r.kind } });
  return out;
}

const FENCE = /^```(\S+)?\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^(?:---+|\*\*\*+|___+)\s*$/;
const BULLET = /^[-*+]\s+(.*)$/;
const TASK = /^[-*+]\s+\[([ xX])\]\s+(.*)$/;
const ORDERED = /^\d+[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

/** Convert Markdown source into an array of block-level ProseMirror nodes. */
export function markdownToBlocks(md: string): JSONContent[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: JSONContent[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    const fence = line.match(FENCE);
    if (fence) {
      const lang = fence[1] ?? null;
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) { body.push(lines[i]); i++; }
      i++; // closing fence
      blocks.push({ type: 'codeBlock', attrs: { language: lang }, content: body.length ? [{ type: 'text', text: body.join('\n') }] : [] });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({ type: 'heading', attrs: { level: Math.min(heading[1].length, 3) }, content: inline(heading[2].trim()).nodes });
      i++; continue;
    }

    if (HR.test(line)) { blocks.push({ type: 'horizontalRule' }); i++; continue; }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) { inner.push(lines[i].match(QUOTE)![1]); i++; }
      blocks.push({ type: 'blockquote', content: markdownToBlocks(inner.join('\n')) });
      continue;
    }

    // Task list — checked before the plain bullet, since a task is also a bullet.
    if (TASK.test(line)) {
      const items: JSONContent[] = [];
      while (i < lines.length && TASK.test(lines[i])) {
        const m = lines[i].match(TASK)!;
        items.push({ type: 'taskItem', attrs: { checked: m[1].toLowerCase() === 'x' }, content: [{ type: 'paragraph', content: inline(m[2].trim()).nodes }] });
        i++;
      }
      blocks.push({ type: 'taskList', content: items });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = ORDERED.test(line);
      const re = ordered ? ORDERED : BULLET;
      const items: JSONContent[] = [];
      while (i < lines.length && re.test(lines[i]) && !TASK.test(lines[i])) {
        const m = lines[i].match(re)!;
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: inline(m[1].trim()).nodes }] });
        i++;
      }
      blocks.push({ type: ordered ? 'orderedList' : 'bulletList', content: items });
      continue;
    }

    // Paragraph: gather consecutive lines until a blank line or a block starter.
    const para: string[] = [];
    while (
      i < lines.length && lines[i].trim() !== '' &&
      !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !HR.test(lines[i]) &&
      !QUOTE.test(lines[i]) && !BULLET.test(lines[i]) && !ORDERED.test(lines[i])
    ) { para.push(lines[i]); i++; }
    blocks.push(...paragraph(para.join('\n')));
  }

  return blocks;
}

/**
 * Day One has no separate title field — the first *line* of an entry is its title.
 * A leading heading is single-line, so its whole text becomes the title. A leading
 * paragraph, however, can run for many lines joined by soft breaks (a single "\n"
 * doesn't end a Markdown paragraph), so we take only the text up to the first soft
 * break and keep the rest of the paragraph in the body — otherwise a long opening
 * paragraph would be swallowed whole into the title (and truncated past the cap,
 * losing content).
 */
export function splitTitle(blocks: JSONContent[]): { title: string; body: JSONContent[] } {
  const first = blocks[0];
  if (!first) return { title: '', body: blocks };

  if (first.type === 'heading') {
    const title = plainText(first).trim();
    if (title) return { title: title.slice(0, 140), body: blocks.slice(1) };
    return { title: '', body: blocks };
  }

  if (first.type === 'paragraph') {
    const content = first.content ?? [];
    const brk = content.findIndex((n) => n.type === 'hardBreak');
    const headNodes = brk === -1 ? content : content.slice(0, brk);
    const title = headNodes.map(plainText).join('').trim();
    if (!title) return { title: '', body: blocks };

    // A single long line with no break is prose, not a title — leave it in the body.
    if (brk === -1 && title.length > 140) return { title: '', body: blocks };

    // Everything after the first line stays in the body as its own paragraph.
    const restNodes = brk === -1 ? [] : content.slice(brk + 1);
    const body: JSONContent[] = restNodes.length ? [{ type: 'paragraph', content: restNodes }] : [];
    body.push(...blocks.slice(1));
    return { title: title.slice(0, 140), body };
  }

  return { title: '', body: blocks };
}

function plainText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return ' ';
  return (node.content ?? []).map(plainText).join('');
}
