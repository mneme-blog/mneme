// Import orchestrator: turns a parsed Day One archive into real Mneme entries.
// It drives the public app surface (createEntry/updateEntry/addMedia/newJournal),
// so everything it writes is encrypted and queued for sync exactly like
// hand-authored content — there is no special import path through the relay.
//
// Per entry: parse the Markdown body, create the entry (to get an id), encrypt and
// attach each referenced media file, then write the final document + original date
// back. Media files missing from a partial export are skipped, not fatal.
import type { JSONContent } from '@tiptap/core';
import type { MediaAttachment } from '../sync/engine';
import type { Journal, CoverPattern } from '../data/sample';
import { docToText } from '../editor/doc';
import { MEDIA_NODE, GALLERY_NODE } from '../editor/media';
import { markdownToBlocks, splitTitle, MEDIA_REF } from './markdown';
import { entryMoments, type DayOneArchive, type DayOneEntry } from './dayone';

/** The slice of AppData the importer needs — keeps it testable with a mock. */
export interface ImportApi {
  journals: Journal[];
  newJournal(j: Journal): void;
  createEntry(input: { journalId: string; title?: string; bodyText?: string; bodyJson?: string; labels?: string[] }): { id: string };
  updateEntry(id: string, patch: { title?: string; bodyText?: string; bodyJson?: string; labels?: string[]; createdAt?: number }): void;
  addMedia(
    entryId: string,
    kind: MediaAttachment['kind'],
    blob: Blob,
    meta?: { durationMs?: number; name?: string; width?: number; height?: number },
  ): Promise<MediaAttachment | null>;
}

export interface ImportProgress {
  done: number;
  total: number;
  /** Title of the entry currently being written (for the progress line). */
  current: string;
}

export interface ImportSummary {
  journals: number; // notebooks created (existing ones reused, not counted)
  entries: number;
  media: number; // media files successfully attached
  skippedMedia: number; // referenced but missing from the archive
}

const JCOLORS = ['#B0563A', '#4E8B85', '#6A6AA0', '#B08A2E', '#5A7BA6', '#6E8B5E', '#8E6A93', '#C06A4A'];
const JCOVERS: CoverPattern[] = ['lines', 'dots', 'grid', 'plain'];

/**
 * Run the import. Resolves to a summary; rejects only on a programming error —
 * per-entry/per-media failures are absorbed (the entry still imports without the
 * broken piece) so one bad record can't abort a large journal.
 */
export async function importDayOne(
  archive: DayOneArchive,
  api: ImportApi,
  onProgress?: (p: ImportProgress) => void,
  // Injectable for tests (jsdom/node have no global Blob with the same shape).
  makeBlob: (bytes: Uint8Array, mime: string) => Blob = (bytes, mime) => new Blob([bytes as BlobPart], { type: mime }),
): Promise<ImportSummary> {
  const summary: ImportSummary = { journals: 0, entries: 0, media: 0, skippedMedia: 0 };
  const total = archive.entryCount;
  let done = 0;

  // Resolve each Day One journal name to a Mneme journal id, creating notebooks
  // as needed. Match existing notebooks case-insensitively by name.
  const byName = new Map<string, string>();
  for (const j of api.journals) byName.set(j.name.toLowerCase(), j.id);
  let created = 0;
  const journalIdFor = (name: string): string => {
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (existing) return existing;
    const id = `j-import-${created}-${idStamp()}`;
    const journal: Journal = {
      id,
      name,
      subtitle: 'Imported from Day One',
      count: 0,
      color: JCOLORS[created % JCOLORS.length],
      cover: JCOVERS[created % JCOVERS.length],
      last: '',
    };
    api.newJournal(journal);
    byName.set(key, id);
    created++;
    summary.journals++;
    return id;
  };

  for (const journal of archive.journals) {
    const journalId = journalIdFor(journal.name);
    for (const entry of journal.entries) {
      const blocks = markdownToBlocks(entry.text ?? '');
      const { title, body } = splitTitle(blocks);
      const labels = (entry.tags ?? []).filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim());

      const ref = api.createEntry({ journalId, title: title || undefined, labels });
      const content = await resolveMedia(body, entry, archive, api, ref.id, summary, makeBlob);
      const doc: JSONContent = { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };

      // Omit an empty title from the patch so createEntry's date-based default
      // survives (an explicit `title: undefined` would overwrite it via spread).
      api.updateEntry(ref.id, {
        ...(title ? { title } : {}),
        bodyJson: JSON.stringify(doc),
        bodyText: docToText(doc),
        labels,
        createdAt: parseDate(entry.creationDate),
      });

      summary.entries++;
      done++;
      onProgress?.({ done, total, current: title || 'Untitled entry' });
    }
  }

  return summary;
}

// Walk the parsed body, replacing each media-ref placeholder with a real
// attachment (encrypted + queued by addMedia). Consecutive images collapse into
// one gallery, matching how the editor groups picked photos.
async function resolveMedia(
  body: JSONContent[],
  entry: DayOneEntry,
  archive: DayOneArchive,
  api: ImportApi,
  entryId: string,
  summary: ImportSummary,
  makeBlob: (bytes: Uint8Array, mime: string) => Blob,
): Promise<JSONContent[]> {
  const moments = entryMoments(entry);
  const out: JSONContent[] = [];
  let imageRun: MediaAttachment[] = [];
  const flushImages = (): void => {
    if (imageRun.length === 1) out.push({ type: MEDIA_NODE, attrs: { ...imageRun[0] } });
    else if (imageRun.length > 1) out.push({ type: GALLERY_NODE, attrs: { images: imageRun } });
    imageRun = [];
  };

  for (const node of body) {
    if (node.type !== MEDIA_REF) {
      flushImages();
      out.push(node);
      continue;
    }
    const identifier = String(node.attrs?.identifier ?? '');
    const found = moments.get(identifier);
    const resolved = found ? archive.resolve(found.moment, found.kind) : null;
    if (!resolved) { summary.skippedMedia++; continue; }

    const att = await api.addMedia(entryId, resolved.kind, makeBlob(resolved.bytes, resolved.mime), {
      name: resolved.name,
      width: resolved.width,
      height: resolved.height,
      durationMs: resolved.durationMs,
    });
    if (!att) { summary.skippedMedia++; continue; }
    summary.media++;

    if (att.kind === 'image') imageRun.push(att);
    else { flushImages(); out.push({ type: MEDIA_NODE, attrs: { ...att } }); }
  }
  flushImages();
  return out;
}

function parseDate(iso: string | undefined): number {
  if (!iso) return Date.now();
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Date.now() : t;
}

// A short, monotonic-enough suffix for generated journal ids.
function idStamp(): string {
  return Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}
