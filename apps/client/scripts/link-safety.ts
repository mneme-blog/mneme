// Regression check for the link-href allowlist (audit finding M1, issue #42).
//
// Untrusted Markdown — a Day One export `.zip`, or source pasted into the
// Markdown pane — used to produce a TipTap `link` mark with whatever the href
// capture group matched. `[click](javascript:steal())` therefore became a live
// link in a stored, synced entry, one click away from running with the vault
// unlocked and every key in memory.
//
// This asserts the three places the allowlist is now applied: the import
// parser, the editor's Markdown parser, and the Markdown serializer.
// Run: pnpm --filter client exec tsx scripts/link-safety.ts
import type { JSONContent } from '@tiptap/core';
import { isSafeHref, safeHref } from '../src/editor/url';
import { docToMarkdown, markdownToDoc } from '../src/editor/markdown';
import { markdownToBlocks } from '../src/import/markdown';

let failures = 0;
function check(label: string, ok: boolean): void {
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${label}`);
  } else {
    console.log(`  ok    ${label}`);
  }
}

// Collect every href reachable in a doc, at any depth.
function hrefs(node: JSONContent): string[] {
  const out: string[] = [];
  const walk = (n: JSONContent): void => {
    for (const m of n.marks ?? []) {
      if (m.type === 'link' && typeof m.attrs?.href === 'string') out.push(m.attrs.href);
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(node);
  return out;
}

const DANGEROUS = [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  '  javascript:alert(1)',
  'java\tscript:alert(1)',
  'java\nscript:alert(1)',
  'jav\u0000ascript:alert(1)',
  '\u200bjavascript:alert(1)',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'blob:https://evil.example/1234',
];

const SAFE = [
  'https://example.com/a?b=c#d',
  'http://example.com',
  'HTTPS://EXAMPLE.COM',
  'mailto:someone@example.com',
  'tel:+15551234',
  '/relative/path',
  '#fragment',
  'relative.html',
];

console.log('isSafeHref — dangerous schemes are rejected');
for (const href of DANGEROUS) {
  check(JSON.stringify(href), isSafeHref(href) === false);
}

console.log('\nisSafeHref — ordinary links still pass');
for (const href of SAFE) {
  check(JSON.stringify(href), isSafeHref(href) === true);
}

console.log('\nisSafeHref — non-strings and empties are rejected');
check('undefined', safeHref(undefined) === null);
check('null', safeHref(null) === null);
check('number', safeHref(42) === null);
check('empty string', safeHref('') === null);
check('whitespace only', safeHref('   ') === null);

console.log('\nDay One import parser drops the mark, keeps the text');
for (const href of DANGEROUS) {
  const doc: JSONContent = { type: 'doc', content: markdownToBlocks(`See [click me](${href.replace(/\n/g, '')}) here.`) };
  const found = hrefs(doc);
  const text = JSON.stringify(doc).includes('click me');
  check(`${JSON.stringify(href)} → no link mark`, found.length === 0);
  check(`${JSON.stringify(href)} → text preserved`, text);
}

console.log('\nDay One import parser keeps legitimate links');
{
  const doc: JSONContent = { type: 'doc', content: markdownToBlocks('See [the docs](https://example.com/x) here.') };
  // Exact equality on the extracted hrefs, not a substring test: the doc must
  // hold precisely one link and it must be precisely this URL.
  const found = hrefs(doc);
  check('https link survives', found.length === 1 && found[0] === 'https://example.com/x');
}

console.log('\nEditor markdown parser drops the mark');
for (const href of DANGEROUS) {
  const doc = markdownToDoc(`[click me](${href.replace(/\n/g, '')})`);
  check(`${JSON.stringify(href)} → no link mark`, hrefs(doc).length === 0);
}
{
  const doc = markdownToDoc('[the docs](https://example.com/x)');
  const found = hrefs(doc);
  check('https link survives', found.length === 1 && found[0] === 'https://example.com/x');
}

console.log('\nSerializer refuses to round-trip a bad href stored by an older build');
for (const href of DANGEROUS) {
  const doc: JSONContent = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'click me', marks: [{ type: 'link', attrs: { href } }] }],
      },
    ],
  };
  const md = docToMarkdown(doc);
  check(`${JSON.stringify(href)} → not emitted`, !md.includes('](') && md.includes('click me'));
  // …and re-parsing what we emitted must not resurrect it either.
  check(`${JSON.stringify(href)} → no link after reparse`, hrefs(markdownToDoc(md)).length === 0);
}

console.log(failures === 0 ? '\nAll link-safety checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
