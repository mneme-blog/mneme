// Pure data layer for the video-interview node: the shapes, defensive coercion,
// the media-id walk, and the out-of-editor film write-back.
//
// Deliberately free of Preact and UI imports so editor/doc.ts (and through it
// ai/interview.ts, sync/rotate.ts, and the jsdom repro scripts) can use it
// without pulling in the card — editor/videointerview.tsx imports Attachments,
// which reaches state/data.tsx, which imports doc.ts. That would be a cycle.
import type { JSONContent } from '@tiptap/core';
import type { MediaAttachment } from '../sync/engine';

export const VIDEO_INTERVIEW_NODE = 'videoInterview';

/** One planned question and the clip answering it (null when skipped). */
export interface VideoInterviewCard {
  q: string;
  clip: MediaAttachment | null;
  /** Speech-to-text of the answer. On the card, not the clip, so it survives
   *  "Delete the source clips" — the searchable text outlives the bytes. */
  transcript?: string;
}

export interface VideoInterviewData {
  /** Random hex addressing this node — lets a finished render write the film
   *  back into the right node without a live ProseMirror position. */
  sessionId: string;
  /** The interview type's name; also the label the entry carries. */
  typeName: string;
  cards: VideoInterviewCard[];
  film: MediaAttachment | null;
  /** When the film was rendered; older than a clip's createdAt ⇒ stale. */
  renderedAt: number | null;
}

// Attrs round-trip through JSON, and a doc can be older than the code reading
// it — coerce defensively back into our shapes rather than trusting them.
function coerceClip(raw: unknown): MediaAttachment | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.id !== 'string' || !a.id) return null;
  return {
    id: a.id,
    kind: 'video',
    mime: String(a.mime ?? 'video/webm'),
    bytes: Number(a.bytes ?? 0),
    durationMs: typeof a.durationMs === 'number' ? a.durationMs : undefined,
    name: typeof a.name === 'string' && a.name ? a.name : undefined,
    width: typeof a.width === 'number' ? a.width : undefined,
    height: typeof a.height === 'number' ? a.height : undefined,
    createdAt: Number(a.createdAt ?? 0),
  };
}

/** Rebuild the session data from raw node attrs; null when malformed (render nothing). */
export function coerceVideoInterview(attrs: Record<string, unknown>): VideoInterviewData | null {
  const raw = Array.isArray(attrs.cards) ? attrs.cards : null;
  if (!raw) return null;
  const cards: VideoInterviewCard[] = raw.map((c) => {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    return {
      q: typeof o.q === 'string' ? o.q : '',
      clip: coerceClip(o.clip),
      transcript: typeof o.transcript === 'string' && o.transcript ? o.transcript : undefined,
    };
  });
  if (cards.length === 0) return null;
  return {
    sessionId: typeof attrs.sessionId === 'string' ? attrs.sessionId : '',
    typeName: typeof attrs.typeName === 'string' ? attrs.typeName : '',
    cards,
    film: coerceClip(attrs.film),
    renderedAt: typeof attrs.renderedAt === 'number' ? attrs.renderedAt : null,
  };
}

/**
 * Every media id this node references — all answer clips plus the film.
 *
 * SECURITY-RELEVANT: docMediaIds drives deletion (entry + journal) and phrase
 * rotation. An id missed here is a video blob left behind on the relay after
 * the user deleted the entry. Keep this exhaustive; the repro script asserts
 * the resulting list exactly, so adding a nested media reference without
 * updating this walk fails the check rather than leaking silently.
 */
export function videoInterviewMediaIds(attrs: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const push = (raw: unknown): void => {
    const id = (raw as { id?: unknown } | null | undefined)?.id;
    if (typeof id === 'string' && id) ids.push(id);
  };
  if (Array.isArray(attrs.cards)) {
    for (const c of attrs.cards) push((c as { clip?: unknown } | null)?.clip);
  }
  push(attrs.film);
  return ids;
}

/** Attachments of a session, in the order they appear — clips then the film. */
export function videoInterviewAttachments(data: VideoInterviewData): MediaAttachment[] {
  const out = data.cards.map((c) => c.clip).filter((c): c is MediaAttachment => !!c);
  if (data.film) out.push(data.film);
  return out;
}

/** A film is stale once any answer clip is newer than the render. */
export function isFilmStale(data: VideoInterviewData): boolean {
  if (!data.film || data.renderedAt === null) return false;
  const rendered = data.renderedAt;
  return data.cards.some((c) => c.clip !== null && c.clip.createdAt > rendered);
}

/** A whole document holding one video-interview node (what the session sheet saves). */
export function buildVideoInterviewDoc(data: VideoInterviewData): JSONContent {
  return {
    type: 'doc',
    content: [{ type: VIDEO_INTERVIEW_NODE, attrs: { ...data } }, { type: 'paragraph' }],
  };
}

/**
 * Write a rendered film into the node with this sessionId, as a pure transform
 * of a stored bodyJson string. Used when the render finishes after the user
 * navigated away, so there is no editor instance to dispatch a transaction on.
 * Returns null when the body doesn't parse or holds no such node.
 */
/**
 * Write one answer's transcript into the video-interview node with this
 * sessionId, as a pure transform of a stored bodyJson string — the same
 * out-of-editor write-back shape as setFilmAttr below. Used by the
 * auto-transcribe-after-save flow, which outlives the interview sheet (and
 * usually runs while the freshly saved entry is open). Returns null when the
 * body doesn't parse, holds no such node, or the card index is gone.
 */
export function setTranscriptAttr(
  bodyJson: string | undefined,
  sessionId: string,
  cardIndex: number,
  transcript: string,
): string | null {
  if (!bodyJson || !sessionId) return null;
  let doc: JSONContent;
  try {
    doc = JSON.parse(bodyJson) as JSONContent;
  } catch {
    return null;
  }
  let hit = false;
  const walk = (node: JSONContent): void => {
    if (node.type === VIDEO_INTERVIEW_NODE && node.attrs?.sessionId === sessionId) {
      const cards = node.attrs.cards as unknown;
      if (Array.isArray(cards) && cardIndex >= 0 && cardIndex < cards.length) {
        cards[cardIndex] = { ...(cards[cardIndex] as Record<string, unknown>), transcript };
        hit = true;
      }
    }
    node.content?.forEach(walk);
  };
  walk(doc);
  return hit ? JSON.stringify(doc) : null;
}

export function setFilmAttr(
  bodyJson: string | undefined,
  sessionId: string,
  film: MediaAttachment,
  at: number,
): string | null {
  if (!bodyJson || !sessionId) return null;
  let doc: JSONContent;
  try {
    doc = JSON.parse(bodyJson) as JSONContent;
  } catch {
    return null;
  }
  let hit = false;
  const walk = (node: JSONContent): void => {
    if (node.type === VIDEO_INTERVIEW_NODE && node.attrs?.sessionId === sessionId) {
      node.attrs.film = { ...film };
      node.attrs.renderedAt = at;
      hit = true;
    }
    node.content?.forEach(walk);
  };
  walk(doc);
  return hit ? JSON.stringify(doc) : null;
}
