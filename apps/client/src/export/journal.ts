// Exporting one journal as a single compressed archive: every entry, every
// referenced media file, and a manifest that ties them together.
//
// This is the counterpart to src/import/ — an escape hatch, and the promise that
// backs "your journal is yours". The format is public and documented
// (docs/EXPORT-FORMAT.md) so somebody else can write an importer for it; the
// shapes it writes live in ./format.ts.
//
// Everything happens on the device. The archive holds DECRYPTED content — that
// is the point of an export — so it is exactly as sensitive as the journal
// itself once it lands in the downloads folder. The UI says so before it starts.
//
// Memory is the real constraint: a journal with video in it can be gigabytes, so
// the archive is built through fflate's STREAMING zip rather than zipSync. Media
// is stored (level 0) instead of deflated — video, audio and JPEG are already
// compressed, and re-deflating them costs a full second copy for a percent or
// two. Only the JSON is worth compressing, and it compresses very well.
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate';
import type { JournalEntry, MediaAttachment } from '../sync/engine';
import type { Journal } from '../data/sample';
import { docToMarkdown } from '../editor/markdown';
import { docAttachments, docLinks } from './collect';
import {
  FORMAT,
  FORMAT_VERSION,
  MANIFEST_PATH,
  type ExportEntry,
  type ExportEntryRef,
  type ExportManifest,
  type ExportMedia,
  type ExportMissingMedia,
} from './format';

/**
 * The slice of the app's data context an export needs. Narrow on purpose, the
 * way ImportApi is: it makes the whole run drivable from a test with a plain
 * object, no database and no relay.
 */
export interface ExportApi {
  journals: Journal[];
  entries: JournalEntry[];
  /** Decrypted bytes for one attachment, or null when they cannot be obtained. */
  mediaBlob(entryId: string, att: MediaAttachment): Promise<Blob | null>;
}

export interface ExportProgress {
  done: number;
  total: number;
  /** What is being written right now — an entry title or a media filename. */
  current: string;
}

export interface ExportResult {
  blob: Blob;
  /** Suggested download name, e.g. `mneme-dream-diary-2026-09-08.zip`. */
  filename: string;
  manifest: ExportManifest;
}

/** Injected so the regression script can run without Vite, a clock, or a DOM. */
export interface ExportDeps {
  now?: () => number;
  appVersion?: string;
  makeBlob?: (parts: Uint8Array[], mime: string) => Blob;
}

export class ExportError extends Error {}

// ── naming ──────────────────────────────────────────────────────────────────

// Extensions for the mime types Mneme itself produces. A type that is not here
// falls back to the original filename's extension, then to `.bin` — an archive
// must never be blocked by an unrecognised recording container.
const EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/webm': 'weba',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'application/zip': 'zip',
};

/** Strip a mime's parameters: `video/webm;codecs=vp8` → `video/webm`. */
function baseMime(mime: string): string {
  return mime.split(';')[0].trim().toLowerCase();
}

function extensionFor(att: MediaAttachment): string {
  const known = EXTENSIONS[baseMime(att.mime)];
  if (known) return known;
  const fromName = /\.([A-Za-z0-9]{1,8})$/.exec(att.name ?? '');
  return fromName ? fromName[1].toLowerCase() : 'bin';
}

/**
 * Ids are random hex, but they end up in archive paths, so they are constrained
 * here rather than trusted. An id that survives nothing recognisable falls back
 * to a positional name — a file with an odd name still beats a dropped file, and
 * a path can never escape its directory.
 */
function safeId(id: string, index: number): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return cleaned || `media-${index}`;
}

/** A filesystem- and URL-safe stem for the archive name. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  // Non-Latin journal names (Japanese, Arabic, …) legitimately reduce to
  // nothing here. That is a filename, not data — fall back rather than mangle.
  return slug || 'journal';
}

/** ISO 8601 in UTC with milliseconds — the format's one timestamp spelling. */
function iso(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// ── the archive writer ──────────────────────────────────────────────────────

/**
 * fflate's streaming zip, wrapped so callers can `await` each file. Output
 * chunks accumulate here; the caller turns them into a Blob at the end, which
 * lets the browser spill them to disk instead of pinning the whole archive in
 * the tab twice over.
 */
class ArchiveWriter {
  private chunks: Uint8Array[] = [];
  private failure: Error | null = null;
  private done: Promise<void>;
  private settle!: () => void;
  private zip: Zip;

  constructor() {
    this.done = new Promise((resolve) => {
      this.settle = resolve;
    });
    this.zip = new Zip((err, data, final) => {
      if (err) this.failure ??= err;
      if (data) this.chunks.push(data);
      if (err || final) this.settle();
    });
  }

  /** Add one file. `compress: false` stores it verbatim (already-compressed media). */
  add(path: string, data: Uint8Array, compress: boolean, mtime?: number): void {
    if (this.failure) throw this.failure;
    const file = compress ? new ZipDeflate(path, { level: 6 }) : new ZipPassThrough(path);
    // A sane timestamp makes the archive self-describing in any zip tool.
    if (typeof mtime === 'number' && Number.isFinite(mtime)) file.mtime = new Date(mtime);
    this.zip.add(file);
    file.push(data, true);
  }

  async finish(): Promise<Uint8Array[]> {
    this.zip.end();
    await this.done;
    if (this.failure) throw this.failure;
    return this.chunks;
  }
}

// ── the run ─────────────────────────────────────────────────────────────────

/**
 * Export one journal to a zip archive.
 *
 * Media that cannot be resolved (never uploaded from another device, or the
 * relay is unreachable) is RECORDED rather than fatal: it lands in the
 * manifest's `missingMedia` and the caller reports the count. Losing the whole
 * export because one clip is on a phone that is switched off would be the wrong
 * trade — and an importer can tell the difference, because the file is named in
 * `missingMedia` and absent from `media`.
 */
export async function exportJournal(
  journalId: string,
  api: ExportApi,
  onProgress?: (p: ExportProgress) => void,
  deps: ExportDeps = {},
): Promise<ExportResult> {
  const now = deps.now ?? Date.now;
  const makeBlob = deps.makeBlob ?? ((parts, mime) => new Blob(parts as BlobPart[], { type: mime }));

  const journal = api.journals.find((j) => j.id === journalId);
  if (!journal) throw new ExportError(`no such journal: ${journalId}`);

  // Oldest first: an archive reads like the journal does, and an importer that
  // replays it in order rebuilds the same chronology.
  const entries = api.entries
    .filter((e) => e.journalId === journalId && !e.deleted)
    .sort((a, b) => a.createdAt - b.createdAt);

  // Plan the whole run first so progress has a real denominator: every entry,
  // then every distinct media file across the journal.
  const plan = entries.map((entry) => {
    const doc = parseDoc(entry);
    const inline = docAttachments(doc);
    // Entries written before inline media keep an attachments array; both are
    // real content, and deletion unions them, so an export must too.
    const legacy = (entry.attachments ?? []).filter((a) => a && a.id);
    const seen = new Set(inline.map((a) => a.id));
    const attachments = [...inline, ...legacy.filter((a) => !seen.has(a.id))];
    return { entry, doc, attachments };
  });

  const total = plan.length + plan.reduce((n, p) => n + p.attachments.length, 0);
  let done = 0;
  const step = (current: string): void => {
    done += 1;
    onProgress?.({ done, total, current });
  };

  const writer = new ArchiveWriter();
  const entryRefs: ExportEntryRef[] = [];
  const media: ExportMedia[] = [];
  const missing: ExportMissingMedia[] = [];
  const writtenPaths = new Set<string>();

  for (const { entry, doc, attachments } of plan) {
    const entryPath = `entries/${safeId(entry.id, entryRefs.length)}.json`;
    const entryMedia: ExportMedia[] = [];

    for (const [i, att] of attachments.entries()) {
      const path = `media/${safeId(att.id, i)}.${extensionFor(att)}`;
      const label = att.name || path;
      // The same file can be referenced by two entries; write the bytes once.
      if (writtenPaths.has(path)) {
        const already = media.find((m) => m.path === path);
        if (already) entryMedia.push(already);
        step(label);
        continue;
      }

      const blob = await api.mediaBlob(entry.id, att);
      if (!blob) {
        missing.push({ id: att.id, entryId: entry.id, reason: 'unavailable' });
        step(label);
        continue;
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      writer.add(path, bytes, false, att.createdAt);
      writtenPaths.add(path);

      const record: ExportMedia = {
        id: att.id,
        path,
        kind: att.kind,
        mime: att.mime,
        // The archive holds plaintext, so the file on disk is the truth; the
        // stored `bytes` can be stale if a build ever wrote it wrong.
        bytes: bytes.length,
        name: att.name,
        durationMs: att.durationMs,
        width: att.width,
        height: att.height,
        createdAt: iso(att.createdAt) ?? iso(entry.createdAt) ?? new Date(now()).toISOString(),
        entryId: entry.id,
      };
      media.push(record);
      entryMedia.push(record);
      step(label);
    }

    const payload: ExportEntry = {
      id: entry.id,
      journalId: entry.journalId,
      title: entry.title,
      createdAt: iso(entry.createdAt) ?? new Date(now()).toISOString(),
      updatedAt: iso(entry.updatedAt) ?? iso(entry.createdAt) ?? new Date(now()).toISOString(),
      labels: entry.labels ?? [],
      body: doc,
      markdown: safeMarkdown(doc, entry),
      media: entryMedia,
      links: docLinks(doc),
    };
    writer.add(entryPath, strToU8(JSON.stringify(payload, null, 2)), true, entry.updatedAt);

    entryRefs.push({
      id: entry.id,
      path: entryPath,
      title: entry.title,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
      labels: payload.labels,
      media: entryMedia.map((m) => m.id),
    });
    step(entry.title);
  }

  const manifest: ExportManifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    generator: { app: 'Mneme', version: deps.appVersion ?? 'unknown' },
    exportedAt: new Date(now()).toISOString(),
    journal: {
      id: journal.id,
      name: journal.name,
      subtitle: journal.subtitle || undefined,
      color: journal.color || undefined,
      cover: journal.cover || undefined,
      createdAt: iso(journal.createdAt),
      updatedAt: iso(journal.updatedAt),
    },
    counts: { entries: entryRefs.length, media: media.length, missingMedia: missing.length },
    entries: entryRefs,
    media,
    missingMedia: missing,
  };

  // Manifest and README last: both are written from totals only known now, and a
  // reader looks them up by name rather than by position.
  writer.add(MANIFEST_PATH, strToU8(JSON.stringify(manifest, null, 2)), true, now());
  writer.add('README.md', strToU8(readme(manifest)), true, now());

  const chunks = await writer.finish();
  const stamp = new Date(now()).toISOString().slice(0, 10);
  return {
    blob: makeBlob(chunks, 'application/zip'),
    filename: `mneme-${slugify(journal.name)}-${stamp}.zip`,
    manifest,
  };
}

/** The stored body, defended against a malformed or absent bodyJson. */
function parseDoc(entry: JournalEntry): unknown {
  if (entry.bodyJson) {
    try {
      const parsed: unknown = JSON.parse(entry.bodyJson);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Fall through: a body we cannot parse still has its preview text.
    }
  }
  return {
    type: 'doc',
    content: (entry.bodyText || '')
      .split('\n')
      .map((line) => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' })),
  };
}

/**
 * Markdown is a convenience, never the archive's content of record, so a
 * serializer failure on some exotic document must not take the export down with
 * it — the ProseMirror body is already written and holds everything.
 */
function safeMarkdown(doc: unknown, entry: JournalEntry): string {
  try {
    return docToMarkdown(doc as Parameters<typeof docToMarkdown>[0]);
  } catch {
    return entry.bodyText ?? '';
  }
}

/**
 * A short orientation note inside the archive, for whoever opens it in a year.
 *
 * Deliberately English regardless of the app's language: it is a pointer to the
 * format specification, which is English, and the archive may well be read by
 * someone who is not the person who wrote the journal.
 */
function readme(m: ExportManifest): string {
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  return `# ${m.journal.name}

A Mneme journal export — ${plural(m.counts.entries, 'entry', 'entries')} and ${plural(m.counts.media, 'media file', 'media files')},
written on ${m.exportedAt.slice(0, 10)}.

This archive holds your **decrypted** content. Treat it like the journal itself.

## Layout

- \`${MANIFEST_PATH}\` — the table of contents: the journal, every entry, every media file.
- \`entries/<id>.json\` — one file per entry. \`body\` is the content of record (a
  ProseMirror/TipTap document); \`markdown\` is the same thing rendered readably.
- \`media/<id>.<ext>\` — the pictures, recordings and attachments, decrypted.

## Format

\`${m.format}\`, version ${m.formatVersion}. The full specification — every field and
every document node type — is at:

  https://github.com/mneme-blog/mneme/blob/main/docs/EXPORT-FORMAT.md

It is a stable, documented format: anyone can write an importer for it.
${
  m.counts.missingMedia > 0
    ? `
## Incomplete

${plural(m.counts.missingMedia, 'media file', 'media files')} could not be included — not on the
device that made this export, and not fetchable. They are listed under
\`missingMedia\` in the manifest. Export again from a device that holds them, or
while online, to get a complete archive.
`
    : ''
}`;
}
