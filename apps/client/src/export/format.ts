// The Mneme journal export format — shared types and constants.
//
// This is a PUBLIC, documented interchange format: the spec lives in
// docs/EXPORT-FORMAT.md and third parties are invited to write importers against
// it. That has two consequences for this file.
//
//  1. Field names and shapes here ARE the format. Renaming one is a breaking
//     change to somebody else's importer, not a refactor.
//  2. Anything added to the format must be additive within a version — a reader
//     of v1 must be able to ignore a field it does not know and still be correct.
//     A change that invalidates that bumps FORMAT_VERSION and gets its own
//     section in the spec.

/** Format discriminator written into every manifest. */
export const FORMAT = 'mneme-journal-export';

/** Bumped only for a change a v1 reader could not survive. */
export const FORMAT_VERSION = 1;

/** Where the manifest lives inside the archive. */
export const MANIFEST_PATH = 'mneme-export.json';

/**
 * A media file carried by the archive.
 *
 * `path` is where the bytes are; everything else is the metadata Mneme holds
 * about them. `bytes` is the PLAINTEXT length — the archive stores decrypted
 * media, so it matches the file on disk.
 */
export interface ExportMedia {
  id: string;
  path: string;
  kind: 'video' | 'audio' | 'image' | 'file';
  mime: string;
  bytes: number;
  /** Original filename as captured or picked, when there was one. */
  name?: string;
  durationMs?: number;
  width?: number;
  height?: number;
  /** ISO 8601 (UTC, milliseconds) — when the recording/upload was created. */
  createdAt: string;
  /** The entry this file belongs to. */
  entryId: string;
}

/** A media reference the export could not resolve to bytes. */
export interface ExportMissingMedia {
  id: string;
  entryId: string;
  /** Machine-readable cause; `unavailable` = not on this device and not fetchable. */
  reason: 'unavailable';
}

/** The manifest's index entry for one entry file. */
export interface ExportEntryRef {
  id: string;
  path: string;
  title: string;
  /** ISO 8601 (UTC, milliseconds). */
  createdAt: string;
  updatedAt: string;
  labels: string[];
  /** Ids of the media files this entry references, in document order. */
  media: string[];
}

/** The journal itself. Presentation fields are Mneme's own; importers may ignore them. */
export interface ExportJournalMeta {
  id: string;
  name: string;
  subtitle?: string;
  /** Mneme accent token for the notebook cover, e.g. `terracotta`. */
  color?: string;
  /** Mneme cover pattern: lines | dots | grid | plain | photo. */
  cover?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** `mneme-export.json` — the archive's table of contents. */
export interface ExportManifest {
  format: typeof FORMAT;
  formatVersion: number;
  /** What wrote the archive. Informational; never branch on it. */
  generator: { app: string; version: string };
  /** ISO 8601 (UTC, milliseconds). */
  exportedAt: string;
  journal: ExportJournalMeta;
  counts: { entries: number; media: number; missingMedia: number };
  entries: ExportEntryRef[];
  media: ExportMedia[];
  missingMedia: ExportMissingMedia[];
}

/** `entries/<id>.json` — one written entry. */
export interface ExportEntry {
  id: string;
  journalId: string;
  title: string;
  /** ISO 8601 (UTC, milliseconds). */
  createdAt: string;
  updatedAt: string;
  labels: string[];
  /**
   * THE CANONICAL CONTENT: a ProseMirror document (TipTap's JSON shape). Every
   * feature of an entry — text, formatting, tables, checklists, maths, embedded
   * media, location cards, video interviews, transcripts, cross-entry links —
   * lives in here. docs/EXPORT-FORMAT.md documents every node type.
   */
  body: unknown;
  /**
   * The same document rendered as Markdown, for importers that would rather not
   * walk ProseMirror JSON. DERIVED, never authoritative: Mneme's custom nodes
   * have no Markdown spelling and appear as ```mneme:* fenced JSON blocks.
   */
  markdown: string;
  /** Media referenced by this entry, in document order. */
  media: ExportMedia[];
  /** Ids of other entries this one links to (`entryLink` nodes). */
  links: string[];
}
