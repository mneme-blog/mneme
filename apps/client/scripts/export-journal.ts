// Regression check for the journal export (src/export/).
//
// No DOM and no relay: the export deliberately takes a narrow API slice, so the
// whole run is drivable from a plain object, and the archive it produces is read
// back with fflate here — the same way a third-party importer would.
//
// What this pins:
//  1. The archive's SHAPE — the manifest, one JSON per entry, media bytes at the
//     paths the manifest names. This is a published format (docs/EXPORT-FORMAT.md);
//     a change here is a change to somebody else's importer.
//  2. That every media reference is exported. docAttachments is a second walk over
//     the node types docMediaIds walks for DELETION, and the two drifting apart is
//     the failure that matters: an id docAttachments misses is content silently
//     left out of the user's export. Asserted against a document holding every
//     node type there is.
//  3. That unresolvable media degrades to a recorded gap rather than a failed run.
//
// Run: pnpm --filter client exec tsx scripts/export-journal.ts
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';

import { exportJournal, slugify, type ExportApi } from '../src/export/journal';
import { docAttachments, docLinks } from '../src/export/collect';
import { MANIFEST_PATH, type ExportEntry, type ExportManifest } from '../src/export/format';
import { docMediaIds, docEntryLinks } from '../src/editor/doc';
import { docToMarkdown } from '../src/editor/markdown';
import type { JournalEntry, MediaAttachment } from '../src/sync/engine';
import type { Journal } from '../src/data/sample';

const ok = (msg: string): void => console.log(`✓ ${msg}`);

// ── fixtures ────────────────────────────────────────────────────────────────

function att(id: string, over: Partial<MediaAttachment> = {}): MediaAttachment {
  return {
    id,
    kind: 'video',
    mime: 'video/mp4',
    bytes: 4,
    createdAt: Date.UTC(2026, 0, 2),
    ...over,
  };
}

// A document holding EVERY node type that can reference media, so the walk is
// checked against the real schema rather than a convenient subset.
const richDoc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'A day out' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'See ' },
        { type: 'entryLink', attrs: { entryId: 'e-other', label: 'the other one' } },
        { type: 'text', text: ' and ' },
        { type: 'inlineMath', attrs: { latex: 'x^2' } },
      ],
    },
    { type: 'mediaAttachment', attrs: att('m-clip', { name: 'clip.mp4' }) },
    {
      type: 'mediaGallery',
      attrs: {
        images: [
          att('m-img1', { kind: 'image', mime: 'image/jpeg' }),
          att('m-img2', { kind: 'image', mime: 'image/png' }),
        ],
      },
    },
    {
      type: 'locationMap',
      attrs: {
        from: { lat: 1, lng: 2, label: 'Here' },
        to: null,
        zoom: 13,
        map: att('m-map', { kind: 'image', mime: 'image/png' }),
        photo: att('m-photo', { kind: 'image', mime: 'image/jpeg' }),
      },
    },
    {
      type: 'videoInterview',
      attrs: {
        sessionId: 's1',
        typeName: 'Daily',
        cards: [
          { q: 'How was it?', clip: att('m-a1'), transcript: 'Fine.' },
          { q: 'And then?', clip: att('m-a2') },
          { q: 'Skipped', clip: null },
        ],
        film: att('m-film'),
        renderedAt: Date.UTC(2026, 0, 3),
      },
    },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'r1' }] }] },
          ],
        },
      ],
    },
  ],
};

const RICH_MEDIA = ['m-clip', 'm-img1', 'm-img2', 'm-map', 'm-photo', 'm-a1', 'm-a2', 'm-film'];

const journals: Journal[] = [
  {
    id: 'j-dreams',
    name: 'Dream Diary',
    subtitle: 'at night',
    count: 0,
    color: 'terracotta',
    cover: 'lines',
    last: '',
    createdAt: Date.UTC(2026, 0, 1),
    updatedAt: Date.UTC(2026, 0, 5),
  },
  { id: 'j-other', name: 'Other', subtitle: '', count: 0, color: 'sage', cover: 'dots', last: '' },
];

function entry(over: Partial<JournalEntry>): JournalEntry {
  return {
    id: 'e1',
    journalId: 'j-dreams',
    title: 'Untitled',
    bodyText: '',
    labels: [],
    createdAt: Date.UTC(2026, 0, 2),
    updatedAt: Date.UTC(2026, 0, 2),
    ...over,
  };
}

const entries: JournalEntry[] = [
  entry({
    id: 'e-rich',
    title: 'A day out',
    bodyJson: JSON.stringify(richDoc),
    bodyText: 'A day out',
    labels: ['travel', 'summer'],
    createdAt: Date.UTC(2026, 0, 4),
    updatedAt: Date.UTC(2026, 0, 6),
  }),
  entry({
    id: 'e-plain',
    title: 'Just words',
    bodyText: 'first line\nsecond line',
    createdAt: Date.UTC(2026, 0, 2),
  }),
  // Legacy shape: attachments array, no inline media node.
  entry({
    id: 'e-legacy',
    title: 'Old one',
    bodyText: 'has an attachment',
    attachments: [att('m-legacy', { kind: 'image', mime: 'image/jpeg', name: 'old.jpg' })],
    createdAt: Date.UTC(2026, 0, 3),
  }),
  // Must not appear: another journal, and a tombstone.
  entry({ id: 'e-elsewhere', journalId: 'j-other', title: 'Not mine' }),
  entry({ id: 'e-dead', title: 'Deleted', deleted: true }),
];

function api(over: Partial<ExportApi> = {}): ExportApi {
  return {
    journals,
    entries,
    mediaBlob: async (_entryId, a) => new Blob([new TextEncoder().encode(`bytes:${a.id}`)]),
    ...over,
  };
}

const DEPS = { now: () => Date.UTC(2026, 8, 8, 12), appVersion: '0.5.0-test' };

type Archive = { manifest: ExportManifest; files: Record<string, Uint8Array> };

async function read(blob: Blob): Promise<Archive> {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const manifest = JSON.parse(strFromU8(files[MANIFEST_PATH])) as ExportManifest;
  return { manifest, files };
}

const entryOf = (a: Archive, path: string): ExportEntry =>
  JSON.parse(strFromU8(a.files[path])) as ExportEntry;

// ── 1. the walk matches the one that drives deletion ────────────────────────

function checkWalk(): void {
  // Order-insensitive and duplicate-insensitive: docMediaIds may legitimately
  // repeat an id, docAttachments deduplicates. What must NEVER differ is the
  // SET — an id in one and not the other is either an unexported file or a
  // leaked one.
  const mine = new Set(docAttachments(richDoc).map((a) => a.id));
  const theirs = new Set(docMediaIds(richDoc));
  assert.deepEqual([...mine].sort(), [...theirs].sort(), 'docAttachments must see exactly what docMediaIds sees');
  assert.deepEqual([...mine].sort(), [...RICH_MEDIA].sort(), 'the fixture must cover every media-bearing node');

  // The metadata the ids alone cannot carry.
  const byId = new Map(docAttachments(richDoc).map((a) => [a.id, a]));
  assert.equal(byId.get('m-img1')?.kind, 'image', 'gallery images are images');
  assert.equal(byId.get('m-map')?.mime, 'image/png', 'the location snapshot keeps its mime');
  assert.equal(byId.get('m-clip')?.name, 'clip.mp4', 'filenames survive');

  assert.deepEqual(docLinks(richDoc), docEntryLinks(richDoc), 'link walks must agree');
  assert.deepEqual(docLinks(richDoc), ['e-other']);
  ok('the export media walk matches docMediaIds exactly');
}

// ── 2. archive shape ────────────────────────────────────────────────────────

async function checkArchive(): Promise<void> {
  const result = await exportJournal('j-dreams', api(), undefined, DEPS);
  assert.equal(result.filename, 'mneme-dream-diary-2026-09-08.zip');
  const a = await read(result.blob);

  assert.equal(a.manifest.format, 'mneme-journal-export');
  assert.equal(a.manifest.formatVersion, 1);
  assert.equal(a.manifest.generator.version, '0.5.0-test');
  assert.equal(a.manifest.exportedAt, '2026-09-08T12:00:00.000Z');
  assert.equal(a.manifest.journal.id, 'j-dreams');
  assert.equal(a.manifest.journal.name, 'Dream Diary');
  assert.equal(a.manifest.journal.createdAt, '2026-01-01T00:00:00.000Z');

  // Only this journal's live entries, oldest first.
  assert.deepEqual(
    a.manifest.entries.map((e) => e.id),
    ['e-plain', 'e-legacy', 'e-rich'],
    'other journals and tombstones stay out; order is chronological',
  );
  assert.equal(a.manifest.counts.entries, 3);
  assert.equal(a.manifest.counts.missingMedia, 0);

  // Every path the manifest names is really in the archive.
  for (const e of a.manifest.entries) assert.ok(a.files[e.path], `missing ${e.path}`);
  for (const m of a.manifest.media) {
    assert.ok(a.files[m.path], `missing ${m.path}`);
    assert.equal(strFromU8(a.files[m.path]), `bytes:${m.id}`, `${m.path} holds that file's bytes`);
    assert.equal(m.bytes, a.files[m.path].length, 'manifest bytes match the file on disk');
  }
  assert.ok(a.files['README.md'], 'the archive explains itself');

  // Media: inline nodes plus the legacy attachments array.
  assert.deepEqual(
    a.manifest.media.map((m) => m.id).sort(),
    [...RICH_MEDIA, 'm-legacy'].sort(),
    'legacy attachments are exported alongside inline media',
  );
  const map = a.manifest.media.find((m) => m.id === 'm-map');
  assert.equal(map?.path, 'media/m-map.png', 'extension comes from the mime type');
  assert.equal(a.manifest.media.find((m) => m.id === 'm-clip')?.path, 'media/m-clip.mp4');

  // The entry file.
  const rich = entryOf(a, 'entries/e-rich.json');
  assert.equal(rich.title, 'A day out');
  assert.equal(rich.createdAt, '2026-01-04T00:00:00.000Z');
  assert.equal(rich.updatedAt, '2026-01-06T00:00:00.000Z');
  assert.deepEqual(rich.labels, ['travel', 'summer']);
  assert.deepEqual(rich.body, richDoc, 'the body is the stored document, verbatim');
  assert.deepEqual(rich.links, ['e-other']);
  assert.deepEqual(rich.media.map((m) => m.id), RICH_MEDIA, 'entry media is in document order');
  assert.ok(rich.markdown.includes('A day out'), 'markdown is rendered');
  assert.ok(rich.markdown.includes('[[e-other|the other one]]'), 'entry links use the documented token');
  assert.ok(rich.markdown.includes('mneme:media'), 'media survives markdown as a lossless fence');

  // An entry with no bodyJson still exports a real document.
  const plain = entryOf(a, 'entries/e-plain.json');
  const doc = plain.body as { type: string; content: { content?: { text: string }[] }[] };
  assert.equal(doc.type, 'doc');
  assert.equal(doc.content[0].content?.[0].text, 'first line', 'bodyText becomes paragraphs');
  assert.deepEqual(plain.media, []);
  ok('the archive matches the documented layout');
}

// ── 3. degradation ──────────────────────────────────────────────────────────

// ── 2b. the markdown tokens docs/EXPORT-FORMAT.md §6 promises ───────────────

async function checkMarkdownTokens(): Promise<void> {
  // The spec tells third-party importers exactly how Mneme's custom nodes are
  // spelled in the `markdown` field. Those spellings are the serializer's, not
  // the export's, so they can drift out from under the document — assert them
  // here, where a change fails the check instead of quietly making the
  // published spec wrong.
  const a = await read((await exportJournal('j-dreams', api(), undefined, DEPS)).blob);
  const md = entryOf(a, 'entries/e-rich.json').markdown;

  assert.ok(md.includes('$x^2$'), '§6: inlineMath → $latex$');
  assert.ok(md.includes('[[e-other|the other one]]'), '§6: entryLink → [[entryId|label]]');
  assert.ok(md.includes('```mneme:media'), '§6: mediaAttachment → mneme:media fence');
  assert.ok(md.includes('```mneme:gallery'), '§6: mediaGallery → mneme:gallery fence');
  // The catch-all the spec leans on: nodes with no markdown spelling are still
  // written out in full rather than dropped.
  assert.ok(md.includes('```mneme:node'), '§6: locationMap / videoInterview → mneme:node fence');
  assert.ok(md.includes('m-a1'), 'the mneme:node fence carries the node, not a placeholder');

  const blockMath = docToMarkdown({
    type: 'doc',
    content: [{ type: 'blockMath', attrs: { latex: 'E = mc^2' } }],
  });
  assert.ok(blockMath.includes('$$\nE = mc^2\n$$'), '§6: blockMath → $$ … $$ on their own lines');
  ok('the markdown tokens match what the format spec publishes');
}

async function checkMissingMedia(): Promise<void> {
  const result = await exportJournal(
    'j-dreams',
    api({ mediaBlob: async (_e, a) => (a.id === 'm-a2' ? null : new Blob([new Uint8Array([1])])) }),
    undefined,
    DEPS,
  );
  const a = await read(result.blob);
  assert.equal(a.manifest.counts.missingMedia, 1);
  assert.deepEqual(a.manifest.missingMedia, [{ id: 'm-a2', entryId: 'e-rich', reason: 'unavailable' }]);
  assert.ok(!a.manifest.media.some((m) => m.id === 'm-a2'), 'an unresolvable file is not claimed as present');
  assert.ok(!a.files['media/m-a2.mp4'], 'and its bytes are not there');
  assert.equal(a.manifest.counts.entries, 3, 'the rest of the journal still exports');
  ok('unresolvable media is recorded, not fatal');
}

async function checkProgress(): Promise<void> {
  const seen: { done: number; total: number }[] = [];
  await exportJournal('j-dreams', api(), (p) => seen.push({ done: p.done, total: p.total }), DEPS);
  // 3 entries + 9 media files.
  assert.equal(seen.at(-1)?.total, 12);
  assert.equal(seen.at(-1)?.done, 12, 'progress reaches its total');
  assert.deepEqual(seen.map((s) => s.done), [...Array(12)].map((_, i) => i + 1), 'and advances by one');

  await assert.rejects(() => exportJournal('nope', api(), undefined, DEPS), /no such journal/);
  ok('progress is reported against a real denominator');
}

function checkSlugs(): void {
  assert.equal(slugify('Dream Diary'), 'dream-diary');
  assert.equal(slugify('Träume & Ängste'), 'traume-angste');
  assert.equal(slugify('  ///  '), 'journal', 'a name that reduces to nothing still names a file');
  assert.equal(slugify('日記'), 'journal', 'non-Latin names fall back rather than mangle');
  assert.ok(!slugify('a'.repeat(200)).includes('/'), 'no separators ever reach a path');
  ok('archive names are filesystem-safe');
}

async function main(): Promise<void> {
  checkWalk();
  await checkArchive();
  await checkMarkdownTokens();
  await checkMissingMedia();
  await checkProgress();
  checkSlugs();
  console.log('\nexport-journal: all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
