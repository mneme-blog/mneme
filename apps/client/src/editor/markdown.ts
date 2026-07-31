// Lossless conversion between our ProseMirror document (the stored bodyJson shape)
// and a plain-text Markdown source, so the editor can offer a "WYSIWYG ⇄ markdown
// source" toggle. ProseMirror JSON stays the source of truth; markdown is just an
// alternate editing surface.
//
// Standard nodes (headings, emphasis, lists, task lists, quotes, code blocks, GFM
// tables, rules) round-trip through readable markdown. The custom atoms this app
// adds — math, entry links, media — have no faithful markdown spelling, so they
// serialize to lossless tokens instead:
//   • inline/block math  → `$latex$`  /  `$$ … $$` fence
//   • entry links        → `[[entryId|label]]`
//   • media / galleries  → a ```mneme:* fenced block carrying the node's full JSON
// Anything that can't survive readable markdown without dropping attributes (media,
// galleries, tables with merged or multi-block cells) falls back to a JSON fence,
// keeping the round-trip byte-exact. Callers additionally short-circuit re-parsing
// when the source is untouched (see screens/Editor.tsx), so an unedited toggle is
// always an exact restore regardless of what this module can or can't represent.
import type { JSONContent } from '@tiptap/core';
import { safeHref } from './url';

const FENCE_MEDIA = 'mneme:media';
const FENCE_GALLERY = 'mneme:gallery';
const FENCE_TABLE = 'mneme:table';

// ───────────────────────────── serialize: doc → markdown ─────────────────────

/** Serialize a ProseMirror doc (our bodyJson shape) to markdown source. */
export function docToMarkdown(doc: JSONContent): string {
  const blocks = (doc.content ?? []).map((n) => serializeBlock(n));
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function serializeBlock(node: JSONContent, depth = 0): string {
  switch (node.type) {
    case 'paragraph':
      return serializeInline(node.content);
    case 'heading': {
      const level = clampLevel(node.attrs?.level);
      return `${'#'.repeat(level)} ${serializeInline(node.content)}`;
    }
    case 'blockquote':
      return prefixLines(serializeChildren(node, depth), '> ');
    case 'codeBlock': {
      const lang = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
      const text = plainText(node.content);
      const fence = backtickFence(text);
      return `${fence}${lang}\n${text}\n${fence}`;
    }
    case 'horizontalRule':
      return '---';
    case 'bulletList':
      return serializeList(node, depth, () => '- ');
    case 'orderedList':
      return serializeList(node, depth, (i) => `${(numericStart(node) + i)}. `);
    case 'taskList':
      return serializeTaskList(node, depth);
    case 'table':
      return serializeTable(node);
    case 'blockMath': {
      const latex = typeof node.attrs?.latex === 'string' ? node.attrs.latex : '';
      return `$$\n${latex}\n$$`;
    }
    case 'mediaAttachment':
      return jsonFence(FENCE_MEDIA, node);
    case 'mediaGallery':
      return jsonFence(FENCE_GALLERY, node);
    default:
      // Unknown block: preserve it verbatim so nothing is ever dropped.
      return jsonFence('mneme:node', node);
  }
}

function serializeChildren(node: JSONContent, depth: number): string {
  return (node.content ?? []).map((c) => serializeBlock(c, depth)).join('\n\n');
}

function serializeList(node: JSONContent, depth: number, marker: (i: number) => string): string {
  const items = node.content ?? [];
  return items.map((item, i) => serializeListItem(item, depth, marker(i))).join('\n');
}

function serializeTaskList(node: JSONContent, depth: number): string {
  const items = node.content ?? [];
  return items
    .map((item) => serializeListItem(item, depth, `- [${item.attrs?.checked ? 'x' : ' '}] `))
    .join('\n');
}

// A list item is one or more blocks. The first paragraph sits on the marker line;
// further blocks (including nested lists) are indented to align under it.
function serializeListItem(item: JSONContent, depth: number, marker: string): string {
  const indent = '  '.repeat(depth);
  const pad = ' '.repeat(marker.length);
  const children = item.content ?? [];
  const parts: string[] = [];
  children.forEach((child, idx) => {
    const isList = child.type === 'bulletList' || child.type === 'orderedList' || child.type === 'taskList';
    const rendered = serializeBlock(child, isList ? depth + 1 : depth);
    if (idx === 0 && !isList) {
      parts.push(indent + marker + rendered);
    } else if (isList) {
      parts.push(rendered); // already indented by the deeper depth
    } else {
      parts.push(prefixLines(rendered, indent + pad));
    }
  });
  if (parts.length === 0) parts.push(indent + marker);
  return parts.join('\n');
}

function serializeTable(node: JSONContent): string {
  const rows = node.content ?? [];
  // GFM pipe tables can't express merged cells or multi-block cells — fall back
  // to a JSON fence so those tables still round-trip losslessly.
  if (!tableIsSimple(rows)) return jsonFence(FENCE_TABLE, node);
  const lines: string[] = [];
  rows.forEach((row, r) => {
    const cells = (row.content ?? []).map((cell) => escapePipes(serializeInline(cell.content?.[0]?.content)));
    lines.push(`| ${cells.join(' | ')} |`);
    if (r === 0) lines.push(`| ${cells.map(() => '---').join(' | ')} |`);
  });
  return lines.join('\n');
}

function tableIsSimple(rows: JSONContent[]): boolean {
  for (const row of rows) {
    for (const cell of row.content ?? []) {
      const span = (cell.attrs?.colspan ?? 1) as number;
      const rspan = (cell.attrs?.rowspan ?? 1) as number;
      if (span !== 1 || rspan !== 1) return false;
      const kids = cell.content ?? [];
      if (kids.length !== 1 || kids[0].type !== 'paragraph') return false;
    }
  }
  return rows.length > 0;
}

// ── inline serialization ──

function serializeInline(content: JSONContent[] | undefined): string {
  if (!content) return '';
  return content.map(serializeInlineNode).join('');
}

function serializeInlineNode(node: JSONContent): string {
  if (node.type === 'text') return applyMarks(node.text ?? '', node.marks);
  if (node.type === 'hardBreak') return '\\\n';
  if (node.type === 'inlineMath') {
    const latex = typeof node.attrs?.latex === 'string' ? node.attrs.latex : '';
    return `$${latex}$`;
  }
  if (node.type === 'entryLink') {
    const id = typeof node.attrs?.entryId === 'string' ? node.attrs.entryId : '';
    const label = typeof node.attrs?.label === 'string' ? node.attrs.label : '';
    return `[[${id}|${label}]]`;
  }
  return '';
}

function applyMarks(text: string, marks: JSONContent['marks']): string {
  const names = new Set((marks ?? []).map((m) => m.type));
  // Code is literal: no escaping, no nested emphasis markup inside.
  if (names.has('code')) return '`' + text + '`';
  let s = escapeInline(text);
  if (names.has('strike')) s = `~~${s}~~`;
  // Combined bold+italic uses the `***…***` spelling so it parses back cleanly.
  if (names.has('bold') && names.has('italic')) s = `***${s}***`;
  else if (names.has('bold')) s = `**${s}**`;
  else if (names.has('italic')) s = `*${s}*`;
  const link = (marks ?? []).find((m) => m.type === 'link');
  // Allowlisted on the way out as well as in, so a bad href stored by an older
  // build (or reached by some path this file doesn't know about) can't
  // round-trip back into a live link mark.
  const href = safeHref(link?.attrs?.href);
  if (href !== null) s = `[${s}](${href})`;
  return s;
}

// ───────────────────────────── parse: markdown → doc ─────────────────────────

/** Parse markdown source back into a ProseMirror doc (our bodyJson shape). */
export function markdownToDoc(md: string): JSONContent {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks = parseBlocks(lines, 0, lines.length);
  return { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] };
}

function parseBlocks(lines: string[], start: number, end: number): JSONContent[] {
  const out: JSONContent[] = [];
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    // Fenced blocks (code + our JSON-carrying atoms).
    const fence = line.match(/^(`{3,})(.*)$/);
    if (fence) {
      const close = fence[1];
      const info = fence[2].trim();
      let j = i + 1;
      const body: string[] = [];
      while (j < end && lines[j].trimEnd() !== close) {
        body.push(lines[j]);
        j++;
      }
      out.push(parseFence(info, body.join('\n')));
      i = j + 1;
      continue;
    }
    // Heading.
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push({ type: 'heading', attrs: { level: Math.min(3, h[1].length) }, content: parseInline(h[2]) });
      i++;
      continue;
    }
    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      out.push({ type: 'horizontalRule' });
      i++;
      continue;
    }
    // Block math: a `$$` fence, or a single-line `$$ … $$`.
    const oneLineMath = line.match(/^\$\$(.+)\$\$$/);
    if (oneLineMath) {
      out.push({ type: 'blockMath', attrs: { latex: oneLineMath[1].trim() } });
      i++;
      continue;
    }
    if (line.trim() === '$$') {
      let j = i + 1;
      const body: string[] = [];
      while (j < end && lines[j].trim() !== '$$') {
        body.push(lines[j]);
        j++;
      }
      out.push({ type: 'blockMath', attrs: { latex: body.join('\n').trim() } });
      i = j + 1;
      continue;
    }
    // Blockquote: gather the contiguous `>`-prefixed run, recurse on its content.
    if (/^>\s?/.test(line)) {
      let j = i;
      const inner: string[] = [];
      while (j < end && /^>\s?/.test(lines[j])) {
        inner.push(lines[j].replace(/^>\s?/, ''));
        j++;
      }
      out.push({ type: 'blockquote', content: parseBlocks(inner, 0, inner.length) });
      i = j;
      continue;
    }
    // GFM table: a pipe row immediately followed by a `---` delimiter row.
    if (line.includes('|') && i + 1 < end && isTableDelimiter(lines[i + 1])) {
      let j = i;
      const rows: string[] = [];
      while (j < end && lines[j].includes('|') && lines[j].trim() !== '') {
        rows.push(lines[j]);
        j++;
      }
      out.push(parseTable(rows));
      i = j;
      continue;
    }
    // List (bullet / ordered / task).
    if (/^(\s*)([-*+]|\d+[.)])\s+/.test(line)) {
      let j = i;
      while (j < end && (lines[j].trim() === '' ? false : /^(\s*)([-*+]|\d+[.)])\s+/.test(lines[j]) || /^\s+\S/.test(lines[j]))) {
        // stop the list at a blank line that is followed by a non-indented, non-list line
        j++;
      }
      out.push(parseList(lines.slice(i, j)));
      i = j;
      continue;
    }
    // Paragraph: gather contiguous plain lines (single newlines become hard breaks).
    let j = i;
    const para: string[] = [];
    while (j < end && lines[j].trim() !== '' && !isBlockStart(lines, j)) {
      para.push(lines[j]);
      j++;
    }
    out.push({ type: 'paragraph', content: parseInlineLines(para) });
    i = j;
  }
  return out;
}

// True when a line begins a block that must interrupt an open paragraph.
function isBlockStart(lines: string[], i: number): boolean {
  const line = lines[i];
  if (/^(`{3,})/.test(line)) return true;
  if (/^(#{1,6})\s+/.test(line)) return true;
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) return true;
  if (/^>\s?/.test(line)) return true;
  if (line.trim() === '$$' || /^\$\$(.+)\$\$$/.test(line)) return true;
  if (/^(\s*)([-*+]|\d+[.)])\s+/.test(line)) return true;
  if (line.includes('|') && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) return true;
  return false;
}

function parseFence(info: string, body: string): JSONContent {
  if (info === FENCE_MEDIA || info === FENCE_GALLERY || info === FENCE_TABLE || info === 'mneme:node') {
    try {
      return JSON.parse(body) as JSONContent;
    } catch {
      /* corrupt token — fall through to a code block so nothing explodes */
    }
  }
  return { type: 'codeBlock', attrs: { language: info || null }, content: body ? [{ type: 'text', text: body }] : [] };
}

function isTableDelimiter(line: string): boolean {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');
}

function parseTable(rows: string[]): JSONContent {
  const cellsOf = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());
  const header = cellsOf(rows[0]);
  const bodyRows = rows.slice(2).map(cellsOf);
  const mkRow = (cells: string[], head: boolean): JSONContent => ({
    type: 'tableRow',
    content: cells.map((c) => ({
      type: head ? 'tableHeader' : 'tableCell',
      content: [{ type: 'paragraph', content: parseInline(unescapePipes(c)) }],
    })),
  });
  return { type: 'table', content: [mkRow(header, true), ...bodyRows.map((r) => mkRow(r, false))] };
}

interface RawItem {
  indent: number;
  ordered: boolean;
  checked: boolean | null;
  text: string;
  children: string[];
}

function parseList(lines: string[]): JSONContent {
  const items: RawItem[] = [];
  for (const line of lines) {
    const m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(\[([ xX])\]\s+)?(.*)$/);
    if (m) {
      items.push({
        indent: m[1].length,
        ordered: /\d/.test(m[2]),
        checked: m[3] ? m[4].toLowerCase() === 'x' : null,
        text: m[5],
        children: [],
      });
    } else if (items.length) {
      // Continuation / nested line belongs to the current item.
      items[items.length - 1].children.push(line);
    }
  }
  return buildList(items, 0, { i: 0 });
}

// Build one list (and its nested sublists) from a flat item run, splitting on indent.
function buildList(items: RawItem[], baseIndent: number, cursor: { i: number }): JSONContent {
  const ordered = items[cursor.i].ordered;
  const task = items[cursor.i].checked !== null;
  const listItems: JSONContent[] = [];
  while (cursor.i < items.length && items[cursor.i].indent === baseIndent) {
    const item = items[cursor.i];
    cursor.i++;
    const content: JSONContent[] = [{ type: 'paragraph', content: parseInline(item.text) }];
    // Deeper-indented following items form a nested list under this item.
    if (cursor.i < items.length && items[cursor.i].indent > baseIndent) {
      content.push(buildList(items, items[cursor.i].indent, cursor));
    }
    listItems.push(
      task
        ? { type: 'taskItem', attrs: { checked: item.checked === true }, content }
        : { type: 'listItem', content },
    );
  }
  const type = task ? 'taskList' : ordered ? 'orderedList' : 'bulletList';
  return { type, content: listItems };
}

// ── inline parsing ──

// Join a paragraph's source lines, turning the trailing `\` (or a bare line break)
// into an explicit hardBreak, then tokenize the whole thing.
function parseInlineLines(lines: string[]): JSONContent[] {
  const joined = lines.join('\n');
  return parseInline(joined);
}

function parseInline(src: string, marks: { type: string; attrs?: Record<string, unknown> }[] = []): JSONContent[] {
  const out: JSONContent[] = [];
  let rest = src;
  const pushText = (text: string): void => {
    if (!text) return;
    out.push(marks.length ? { type: 'text', text, marks: marks.map((m) => ({ ...m })) } : { type: 'text', text });
  };
  while (rest.length) {
    const tok = nextToken(rest);
    if (!tok) {
      pushText(unescapeInline(rest));
      break;
    }
    if (tok.index > 0) pushText(unescapeInline(rest.slice(0, tok.index)));
    out.push(...tok.emit(marks));
    rest = rest.slice(tok.index + tok.length);
  }
  return out;
}

interface Token {
  index: number;
  length: number;
  emit: (marks: { type: string; attrs?: Record<string, unknown> }[]) => JSONContent[];
}

// A plain-text inline node carrying the current mark stack.
function markedText(text: string, marks: { type: string; attrs?: Record<string, unknown> }[]): JSONContent {
  return marks.length ? { type: 'text', text, marks: marks.map((m) => ({ ...m })) } : { type: 'text', text };
}

// Find the earliest inline token in `s`. Order of the alternatives only matters
// when two would start at the same index; the earliest index always wins.
function nextToken(s: string): Token | null {
  const patterns: { re: RegExp; make: (m: RegExpMatchArray) => Token['emit'] }[] = [
    // Hard break: a backslash at end of a line.
    { re: /\\\n/, make: () => () => [{ type: 'hardBreak' }] },
    // Escaped character → literal.
    { re: /\\([\\`*_~$\[\]])/, make: (m) => (marks) => [markedText(m[1], marks)] },
    // Entry link [[id|label]] or [[id]].
    {
      re: /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/,
      make: (m) => () => [{ type: 'entryLink', attrs: { entryId: m[1], label: m[2] ?? '' } }],
    },
    // Inline code.
    { re: /`([^`]+)`/, make: (m) => (marks) => [markedText(m[1], [...marks, { type: 'code' }])] },
    // Inline math $…$ (no surrounding $$, handled as block).
    { re: /\$([^$\n]+)\$/, make: (m) => () => [{ type: 'inlineMath', attrs: { latex: m[1] } }] },
    // Link [text](href). A disallowed protocol drops the mark, not the text —
    // the Markdown pane accepts hand-typed and pasted source, so it is an
    // untrusted path too (see ./url.ts).
    {
      re: /\[([^\]]+)\]\(([^)]+)\)/,
      make: (m) => (marks) => {
        const href = safeHref(m[2]);
        return parseInline(m[1], href === null ? marks : [...marks, { type: 'link', attrs: { href } }]);
      },
    },
    // Combined bold+italic, then bold, then italic (longest delimiter first so
    // `***` isn't mistaken for `**` + `*`).
    { re: /\*\*\*([^*]+)\*\*\*/, make: (m) => (marks) => parseInline(m[1], [...marks, { type: 'bold' }, { type: 'italic' }]) },
    { re: /\*\*([^*]+)\*\*/, make: (m) => (marks) => parseInline(m[1], [...marks, { type: 'bold' }]) },
    { re: /__([^_]+)__/, make: (m) => (marks) => parseInline(m[1], [...marks, { type: 'bold' }]) },
    { re: /~~([^~]+)~~/, make: (m) => (marks) => parseInline(m[1], [...marks, { type: 'strike' }]) },
    { re: /\*([^*\n]+)\*/, make: (m) => (marks) => parseInline(m[1], [...marks, { type: 'italic' }]) },
    { re: /_([^_\n]+)_/, make: (m) => (marks) => parseInline(m[1], [...marks, { type: 'italic' }]) },
  ];
  let best: Token | null = null;
  for (const { re, make } of patterns) {
    const m = s.match(re);
    if (m && m.index !== undefined && (best === null || m.index < best.index)) {
      best = { index: m.index, length: m[0].length, emit: make(m) };
      if (m.index === 0) break; // can't beat index 0
    }
  }
  return best;
}

// ───────────────────────────── helpers ──────────────────────────────────────

function clampLevel(level: unknown): number {
  const n = typeof level === 'number' ? level : 1;
  return Math.min(3, Math.max(1, n));
}

function numericStart(node: JSONContent): number {
  const s = node.attrs?.start;
  return typeof s === 'number' && s > 0 ? s : 1;
}

function plainText(content: JSONContent[] | undefined): string {
  return (content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : '')).join('');
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

function backtickFence(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function jsonFence(tag: string, node: JSONContent): string {
  return '```' + tag + '\n' + JSON.stringify(node) + '\n```';
}

function escapeInline(text: string): string {
  return text.replace(/([\\`*_~$\[\]])/g, '\\$1');
}

function unescapeInline(text: string): string {
  return text.replace(/\\([\\`*_~$\[\]])/g, '$1');
}

// Escape the backslash itself alongside the pipe, so the escaping can't be
// subverted by a literal backslash in the input (CodeQL js/incomplete-sanitization).
// unescapePipes is its exact inverse — both run as a matched pair on table cells.
function escapePipes(text: string): string {
  return text.replace(/([\\|])/g, '\\$1');
}

function unescapePipes(text: string): string {
  return text.replace(/\\([\\|])/g, '$1');
}
