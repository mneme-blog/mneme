// The one stateful badge instance — mounted once in app.tsx. Re-derives the
// earned set from the decrypted entries (state/badges.ts is pure) and manages
// the device-local seen-state: quiet catch-up on a device's first evaluation,
// then a one-at-a-time celebration queue for badges earned after that.
// Preferences' gallery calls evaluateBadges directly instead of this hook — a
// second instance would race this one's catch-up writes to localStorage.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useAppData } from '../state/data';
import {
  BADGE_ORDER,
  catchUpOrDelta,
  evaluateBadges,
  loadSeen,
  saveSeen,
  type BadgeId,
} from '../state/badges';

export interface BadgesState {
  /** Every badge currently earned (for galleries/debug). */
  earned: Set<BadgeId>;
  /** The badge to celebrate right now, or null. */
  celebration: BadgeId | null;
  /** Mark the current celebration seen, persist, advance the queue. */
  dismissCelebration(): void;
}

export function useBadges(): BadgesState {
  const { entries, interviewTypes, bootstrapping, status, ownerId } = useAppData();
  // Evaluate only once hydration is done: `bootstrapping` stays true through
  // local hydration AND the first relay pull, so the empty→loaded transition
  // can never read as "everything newly earned". Don't gate on entries.length —
  // a fresh vault holds only tutorial seeds and still needs its catch-up init.
  const ready = !bootstrapping && status !== 'locked' && !!ownerId;

  const typeNames = useMemo(() => interviewTypes.filter((it) => !it.deleted).map((it) => it.name), [interviewTypes]);
  const earned = useMemo<Set<BadgeId>>(
    () => (ready ? evaluateBadges(entries, typeNames) : new Set()),
    [ready, entries, typeNames],
  );

  const [queue, setQueue] = useState<BadgeId[]>([]);
  const seenRef = useRef<Set<BadgeId> | null>(null);
  const ownerRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || !ownerId) return;
    if (ownerRef.current !== ownerId) {
      // Lock → unlock of a (possibly different) vault: start from its own
      // stored seen-state, and drop any celebration queued for the old one.
      ownerRef.current = ownerId;
      seenRef.current = null;
      setQueue([]);
    }
    const seen = seenRef.current ?? loadSeen(localStorage, ownerId);
    const { seen: nextSeen, celebrate } = catchUpOrDelta(seen, earned);
    if (seen === null) {
      // First evaluation on this device: adopt everything already earned,
      // silently — pre-existing achievements show in the gallery, no parade.
      seenRef.current = nextSeen;
      saveSeen(localStorage, ownerId, nextSeen);
      return;
    }
    seenRef.current = nextSeen;
    if (celebrate.length) {
      // Merge instead of replace so an overlay the user is looking at isn't
      // reordered from under them (a background pull can add more).
      setQueue((q) => [...q, ...celebrate.filter((id) => !q.includes(id))]);
    }
    // A badge can also silently un-queue if its entries were deleted meanwhile.
    setQueue((q) => q.filter((id) => earned.has(id)));
  }, [ready, ownerId, earned]);

  const celebration = queue.length ? queue[0] : null;
  const dismissCelebration = (): void => {
    if (!celebration || !ownerRef.current) return;
    const seen = new Set(seenRef.current ?? []);
    seen.add(celebration);
    seenRef.current = seen;
    saveSeen(localStorage, ownerRef.current, seen);
    setQueue((q) => q.slice(1));
  };

  return { earned, celebration, dismissCelebration };
}

/** Fixed gallery order, re-exported so UI code doesn't import state/badges directly. */
export { BADGE_ORDER };
