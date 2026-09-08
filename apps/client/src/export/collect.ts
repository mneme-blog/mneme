// Walking an entry document for the media it references, with the metadata each
// reference carries.
//
// `docMediaIds` (src/editor/doc.ts) already walks the same nodes, but it returns
// bare ids — the export needs mime types, byte counts and filenames too, and it
// must not import the node modules (they reach into UI components, and this file
// has to stay loadable from a plain node script).
//
// So this is a deliberate second walk over the same node types, kept honest by
// scripts/export-journal.ts, which asserts that the ids collected here match
// `docMediaIds` EXACTLY for a document containing every node type. That check is
// the reason a nested media reference added later cannot silently go unexported
// — the same guard docMediaIds itself carries for deletion.
import type { MediaAttachment } from '../sync/engine';

type Attrs = Record<string, unknown>;

const isAttrs = (v: unknown): v is Attrs => !!v && typeof v === 'object';

/**
 * Coerce raw node attrs back into a MediaAttachment. Node attrs round-trip
 * through JSON and may come from an older build, so every field is defended.
 * Mirrors `nodeAttachment` in src/editor/media.tsx.
 */
function coerce(raw: unknown, forceKind?: MediaAttachment['kind']): MediaAttachment | null {
  if (!isAttrs(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!id) return null;
  const kind = raw.kind;
  return {
    id,
    kind: forceKind ?? (kind === 'audio' || kind === 'image' || kind === 'file' ? kind : 'video'),
    mime: typeof raw.mime === 'string' ? raw.mime : '',
    bytes: Number(raw.bytes ?? 0),
    durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : undefined,
    name: typeof raw.name === 'string' && raw.name ? raw.name : undefined,
    width: typeof raw.width === 'number' ? raw.width : undefined,
    height: typeof raw.height === 'number' ? raw.height : undefined,
    createdAt: Number(raw.createdAt ?? 0),
    transcript: typeof raw.transcript === 'string' && raw.transcript ? raw.transcript : undefined,
  };
}

/**
 * Every media attachment a document references, in document order, deduplicated
 * by id (the same clip can legitimately appear twice).
 *
 * Node types walked — keep in step with `docMediaIds`:
 *   mediaAttachment  → the node itself
 *   mediaGallery     → every image in `images`
 *   locationMap      → the frozen map snapshot and the optional travel photo
 *   videoInterview   → one clip per answered card, plus the rendered film
 */
export function docAttachments(doc: unknown): MediaAttachment[] {
  const out: MediaAttachment[] = [];
  const seen = new Set<string>();
  const push = (att: MediaAttachment | null): void => {
    if (att && !seen.has(att.id)) {
      seen.add(att.id);
      out.push(att);
    }
  };

  const walk = (node: unknown): void => {
    if (!isAttrs(node)) return;
    const attrs = isAttrs(node.attrs) ? node.attrs : {};
    switch (node.type) {
      case 'mediaAttachment':
        push(coerce(attrs));
        break;
      case 'mediaGallery':
        if (Array.isArray(attrs.images)) for (const img of attrs.images) push(coerce(img, 'image'));
        break;
      case 'locationMap':
        push(coerce(attrs.map, 'image'));
        push(coerce(attrs.photo, 'image'));
        break;
      case 'videoInterview':
        if (Array.isArray(attrs.cards)) {
          for (const card of attrs.cards) {
            if (isAttrs(card)) push(coerce(card.clip));
          }
        }
        push(coerce(attrs.film));
        break;
    }
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };

  walk(doc);
  return out;
}

/** Entry ids referenced by `entryLink` nodes, in document order. Mirrors `docEntryLinks`. */
export function docLinks(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (!isAttrs(node)) return;
    if (node.type === 'entryLink' && isAttrs(node.attrs) && typeof node.attrs.entryId === 'string') {
      if (node.attrs.entryId) out.push(node.attrs.entryId);
    }
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(doc);
  return out;
}
