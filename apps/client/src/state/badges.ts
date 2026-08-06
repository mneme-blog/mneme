// Badges — derived gamification awards. Pure logic, no Preact: badges are
// recomputed from the decrypted in-memory entries every session (like stats.ts),
// so there is nothing to sync, nothing to migrate, and nothing badge-shaped
// ever reaches the relay. The only persisted state is "which celebrations were
// already shown", device-local in localStorage (the IOSNotice idiom), keyed
// per owner so a second vault on the same device starts fresh (ownerId is
// non-secret — it is already cleartext on the relay).
import type { JournalEntry } from '../sync/engine';
import { longestStreak, totalWords, wordCount } from './stats';
import { parseBody, docMediaIds } from '../editor/doc';
import { VIDEO_INTERVIEW_NODE } from '../editor/videointerviewData';
import { ENTRIES } from '../data/sample';
import type { JSONContent } from '@tiptap/core';

export type BadgeId =
  | 'first-words'
  | 'streak-3'
  | 'streak-7'
  | 'wordsmith'
  | 'deep-dive'
  | 'first-interview'
  | 'on-camera'
  | 'memory-keeper';

/** Fixed display + celebration order (gallery grid and overlay queue). */
export const BADGE_ORDER: readonly BadgeId[] = [
  'first-words',
  'streak-3',
  'streak-7',
  'wordsmith',
  'deep-dive',
  'first-interview',
  'on-camera',
  'memory-keeper',
];

// Tutorial seed entries keep their fixed sample ids verbatim (seedEntries in
// state/data.tsx), so excluding them is an id-set check against the source of
// truth — a fresh vault must not open on eight instantly-earned badges.
export const SEED_ENTRY_IDS: ReadonlySet<string> = new Set(ENTRIES.map((e) => e.id));

/** Entries that count toward badges: the user's own, still-alive ones. */
export function userEntries(entries: JournalEntry[]): JournalEntry[] {
  return entries.filter((e) => !e.deleted && !SEED_ENTRY_IDS.has(e.id));
}

/** Depth-first node-type search — the string pre-filter alone can false-positive
 *  on body text that merely mentions the node name. */
function docHasNode(doc: JSONContent, type: string): boolean {
  if (doc.type === type) return true;
  return doc.content?.some((n) => docHasNode(n, type)) ?? false;
}

const DEEP_DIVE_WORDS = 1000;
const WORDSMITH_WORDS = 1000;

/**
 * Evaluate every badge rule over the decrypted entries. `interviewTypeNames`
 * are the live (non-deleted) interview-type names — guided interviews stamp the
 * type name as an entry label, which is the only durable marker they leave.
 * (Localized built-in names can drift across a language switch; accepted.)
 */
export function evaluateBadges(entries: JournalEntry[], interviewTypeNames: string[]): Set<BadgeId> {
  const user = userEntries(entries);
  const earned = new Set<BadgeId>();
  if (user.length > 0) earned.add('first-words');

  const streak = longestStreak(user);
  if (streak >= 3) earned.add('streak-3');
  if (streak >= 7) earned.add('streak-7');

  if (totalWords(user) >= WORDSMITH_WORDS) earned.add('wordsmith');
  if (user.some((e) => wordCount(e.bodyText) >= DEEP_DIVE_WORDS)) earned.add('deep-dive');

  const names = new Set(interviewTypeNames);
  if (user.some((e) => e.labels.some((l) => names.has(l)))) earned.add('first-interview');

  // Cheap substring pre-filters keep the common path parse-free; the doc walk
  // confirms so an entry merely *talking about* a node type doesn't count.
  if (
    user.some(
      (e) => e.bodyJson?.includes(`"${VIDEO_INTERVIEW_NODE}"`) && docHasNode(parseBody(e.bodyJson, e.bodyText), VIDEO_INTERVIEW_NODE),
    )
  ) {
    earned.add('on-camera');
  }
  // Media lives as inline nodes in current entries and as a legacy attachments
  // array in pre-inline ones — either counts as "an entry with media".
  const MEDIA_NODES = /"(?:mediaAttachment|mediaGallery|locationMap|videoInterview)"/;
  if (
    user.some(
      (e) =>
        (e.attachments?.length ?? 0) > 0 ||
        (!!e.bodyJson && MEDIA_NODES.test(e.bodyJson) && docMediaIds(parseBody(e.bodyJson, e.bodyText)).length > 0),
    )
  ) {
    earned.add('memory-keeper');
  }
  return earned;
}

export function seenKey(ownerId: string): string {
  return `mneme.badges.seen.${ownerId}`;
}

type SeenStore = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Load the celebrated-badge set. `null` means "never initialized on this
 * device" (absent or unreadable/corrupt key) — the signal for a quiet catch-up.
 * Corrupt JSON deliberately reads as catch-up, not as an empty set: the safe
 * failure mode is re-initializing silently, never celebrating everything.
 */
export function loadSeen(store: SeenStore, ownerId: string): Set<BadgeId> | null {
  try {
    const raw = store.getItem(seenKey(ownerId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return new Set(parsed.filter((x): x is BadgeId => BADGE_ORDER.includes(x as BadgeId)));
  } catch {
    return null;
  }
}

/** Best-effort persist — worst case a celebration re-shows next launch. */
export function saveSeen(store: SeenStore, ownerId: string, seen: ReadonlySet<BadgeId>): void {
  try {
    store.setItem(seenKey(ownerId), JSON.stringify(BADGE_ORDER.filter((id) => seen.has(id))));
  } catch {
    /* storage unavailable (private mode / disabled) */
  }
}

/**
 * The catch-up/delta decision. First evaluation on a device (`seen === null`)
 * quietly adopts everything already earned — pre-existing achievements appear
 * in the gallery without a parade of overlays. Afterwards, earned-minus-seen
 * celebrates in fixed order.
 */
export function catchUpOrDelta(
  seen: ReadonlySet<BadgeId> | null,
  earned: ReadonlySet<BadgeId>,
): { seen: Set<BadgeId>; celebrate: BadgeId[] } {
  if (seen === null) return { seen: new Set(earned), celebrate: [] };
  return { seen: new Set(seen), celebrate: BADGE_ORDER.filter((id) => earned.has(id) && !seen.has(id)) };
}
