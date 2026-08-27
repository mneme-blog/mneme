// Two dynamics for the guided interviews, both computed purely over the
// decrypted in-memory entries — nothing here touches the network, and nothing
// new is stored or synced.
//
// 1. THE GAP. When the journal has been quiet for a while, the first question
//    should be about that stretch rather than about today. `journalGap` finds
//    it; the prompts (ai/prompts.ts) carry the tone rules that keep the
//    question an invitation — no guilt, no streak talk, no "welcome back".
//
// 2. OLDER THOUGHTS. Somewhere in the past the user recorded things they were
//    hoping for, planning, or afraid of. `buildRetrospect` surfaces a handful
//    of those older entries so one question can look back at a thought and ask
//    how it sits now. Selection is a cue-word ranking, not an AI call: the
//    model does the actual picking out of the thought, which is what it is good
//    at, while this only decides which older entries are worth showing it.
//
// Both are inputs to prompts, so a miss is cheap — a slightly less interesting
// question, never a wrong entry or a lost one.
//
// Both are also OPT-IN (see the preference at the bottom of this file): under a
// cloud backend they widen what an interview sends out of E2EE, from "previous
// entries with this label" to "the last entry, and older ones from anywhere in
// the vault". That is the user's call to make, with the consequence in front of
// them (ui/ReflectionConsent.tsx), not a default they discover afterwards.
import type { JournalEntry } from '../sync/engine';
import { entryHeading, entryText } from './flatten';

const DAY_MS = 86_400_000;

// ── the gap ───────────────────────────────────────────────────────────────

/** Silence shorter than this is just life; the interview says nothing about it. */
export const GAP_MIN_DAYS = 8;
/** How much of the last entry the model gets, to open from something concrete. */
const GAP_EXCERPT_CAP = 700;

export interface JournalGap {
  /** Whole days since the journal was last written to. */
  days: number;
  /** When that last activity was (ms). */
  lastAt: number;
  lastTitle: string;
  /** A capped excerpt of that entry — untrusted content, fenced by the caller. */
  lastText: string;
}

/**
 * The most recent moment this journal was written to, per entry.
 *
 * `createdAt` is the entry's own date and the user can re-date an entry into
 * the past (or an import can carry a decade-old one), so the later of the two
 * timestamps is what "when did I last journal" actually means. Clamped to now,
 * because a re-dated or clock-skewed entry must not produce a negative gap.
 */
function activityAt(e: JournalEntry, now: number): number {
  return Math.min(now, Math.max(e.createdAt, e.updatedAt));
}

/**
 * How long the journal has been quiet, or null when it hasn't been (or when
 * there is nothing to have been quiet about — a first-ever entry is not a gap).
 */
export function journalGap(
  entries: JournalEntry[],
  { now = Date.now(), minDays = GAP_MIN_DAYS }: { now?: number; minDays?: number } = {},
): JournalGap | null {
  let last: JournalEntry | null = null;
  let lastAt = 0;
  for (const e of entries) {
    if (e.deleted) continue;
    const at = activityAt(e, now);
    if (at > lastAt) {
      lastAt = at;
      last = e;
    }
  }
  if (!last) return null;
  const days = Math.floor((now - lastAt) / DAY_MS);
  if (days < minDays) return null;
  return {
    days,
    lastAt,
    lastTitle: last.title || 'Untitled',
    lastText: entryText(last, GAP_EXCERPT_CAP, '[…]'),
  };
}

// ── older thoughts ────────────────────────────────────────────────────────

/** Younger than this is not "looking back", it's still the present. */
export const RETRO_MIN_AGE_DAYS = 30;
/** Total size of the retrospect block. */
export const RETRO_BUDGET_CHARS = 4_000;
/** Per entry — enough context to recognise a thought, not a re-read. */
const RETRO_ENTRY_CAP = 1_100;
/** Don't stack three picks from the same week; spread them over the vault. */
const RETRO_SPACING_DAYS = 21;
/** Scoring reads the flat body text, capped — this runs over the whole vault. */
const SCAN_CAP = 4_000;
/** How many entries the uncued fallback samples across the vault's history. */
const RETRO_FALLBACK_PICKS = 6;
/** Below this an entry is a note, not a thought worth revisiting. */
const MIN_SUBSTANCE_CHARS = 120;

// Forward-looking cue stems: hopes, plans, dreams, worries, fears, and "later"
// markers. Substrings of lowercased text, so stems cover inflections ("hoff"
// catches hoffe/hoffen/Hoffnung). Every language ships at once rather than only
// the UI locale's, because the app's language is no evidence of the journal's —
// the same lesson the transcription language picker learned the hard way.
//
// This is a RANKING HINT and nothing more: it decides which older entries the
// model gets to look at. A journal in a language not listed here still works —
// the selection just falls back to a spread over time and the prompt is told
// the entries were picked by age rather than by content.
const CUES: readonly string[] = [
  // English
  'i hope', 'hoping', 'hopeful', 'i wish', 'afraid', 'scared', 'worried', 'worry', 'anxious',
  'i fear', 'dread', 'i want to', 'i plan', 'planning to', 'my goal', 'dream of', 'someday',
  'one day', 'next year', 'five years', 'the future', 'looking forward', 'nervous about', 'what if',
  // German
  'hoff', 'angst', 'befürcht', 'sorge', 'nervös', 'wünsch', 'mein ziel', 'traum', 'träum',
  'vorhaben', 'ich plane', 'zukunft', 'eines tages', 'nächstes jahr', 'freue mich auf',
  // French
  'espère', 'espoir', 'peur', 'crains', 'crainte', 'inquiet', 'angoiss', 'souhaite', 'objectif',
  'rêve', 'avenir', 'un jour', 'année prochaine', 'hâte de',
  // Spanish
  'espero', 'esperanza', 'miedo', 'temo', 'preocup', 'ansios', 'deseo', 'mi meta', 'sueño',
  'futuro', 'algún día', 'año que viene', 'ganas de',
  // Italian
  'spero', 'speranza', 'paura', 'preoccup', 'ansios', 'desiderio', 'obiettivo', 'sogno',
  'futuro', 'un giorno', 'anno prossimo', 'non vedo l’ora',
  // Dutch
  'ik hoop', 'hopelijk', 'bang', 'bezorgd', 'zorgen', 'wens', 'mijn doel', 'droom', 'toekomst',
  'ooit', 'volgend jaar', 'kijk uit naar',
  // Finnish
  'toivo', 'pelko', 'pelkään', 'huoli', 'ahdist', 'haave', 'tavoite', 'unelm', 'suunnitel',
  'tulevaisu', 'joskus', 'ensi vuonna', 'odotan innolla',
  // Chinese
  '希望', '担心', '害怕', '恐惧', '焦虑', '梦想', '目标', '计划', '未来', '将来', '明年', '有一天', '期待',
  // Japanese
  '願っ', '不安', '怖', '心配', '恐れ', '夢', '目標', '計画', '将来', '来年', 'いつか', '楽しみ',
  // Korean
  '희망', '바라', '두렵', '걱정', '불안', '무서', '꿈', '목표', '계획', '미래', '앞으로', '내년', '언젠가', '기대',
  // Hindi
  'उम्मीद', 'आशा', 'डर', 'चिंता', 'घबरा', 'सपना', 'लक्ष्य', 'योजना', 'भविष्य', 'किसी दिन', 'अगले साल',
  // Arabic
  'أمل', 'آمل', 'خوف', 'أخاف', 'قلق', 'حلم', 'هدف', 'خطة', 'المستقبل', 'يوما ما', 'أتطلع',
];

export interface Retrospect {
  text: string;
  count: number;
  /**
   * True when the entries were chosen because they read as forward-looking.
   * False means they are a spread over time and may hold nothing of the sort —
   * the prompt says so, so the model can drop the idea instead of inventing one.
   */
  cued: boolean;
}

const EMPTY: Retrospect = { text: '', count: 0, cued: false };

/** How many distinct cue stems an entry hits (distinct, so one repeated word
 *  can't outweigh an entry that genuinely circles several hopes and fears). */
function cueScore(e: JournalEntry): number {
  const hay = `${e.title}\n${e.bodyText}`.slice(0, SCAN_CAP).toLowerCase();
  let n = 0;
  for (const cue of CUES) if (hay.includes(cue)) n++;
  return n;
}

/** Fill the budget from `picked`, keeping at least RETRO_SPACING_DAYS between
 *  the entries taken so the block spans the vault rather than one good week. */
function assemble(picked: JournalEntry[], budgetChars: number): { text: string; count: number } {
  const blocks: string[] = [];
  const takenAt: number[] = [];
  let used = 0;
  for (const e of picked) {
    if (takenAt.some((t) => Math.abs(t - e.createdAt) < RETRO_SPACING_DAYS * DAY_MS)) continue;
    const block = `${entryHeading(e)}\n\n${entryText(e, RETRO_ENTRY_CAP, '[…]')}`;
    if (used + block.length > budgetChars) break;
    blocks.push(block);
    takenAt.push(e.createdAt);
    used += block.length;
  }
  return { text: blocks.join('\n---\n\n'), count: blocks.length };
}

/**
 * Older entries the interview can look back at — the ones that read as
 * forward-looking (hopes, plans, worries, fears) first, and a spread over time
 * as the fallback when the cues find nothing (a journal in an unlisted
 * language, or simply a matter-of-fact one).
 *
 * `excludeIds` is how the caller keeps the same entries out of two blocks: the
 * same-type history (ai/interview.ts) is already in the prompt.
 */
export function buildRetrospect(
  entries: JournalEntry[],
  {
    now = Date.now(),
    excludeIds,
    budgetChars = RETRO_BUDGET_CHARS,
    minAgeDays = RETRO_MIN_AGE_DAYS,
  }: { now?: number; excludeIds?: Iterable<string>; budgetChars?: number; minAgeDays?: number } = {},
): Retrospect {
  const skip = new Set(excludeIds ?? []);
  const cutoff = now - minAgeDays * DAY_MS;
  const eligible = entries.filter(
    (e) => !e.deleted && !skip.has(e.id) && e.createdAt < cutoff && `${e.title}${e.bodyText}`.length >= MIN_SUBSTANCE_CHARS,
  );
  if (eligible.length === 0) return EMPTY;

  // Strongest cue signal first; among equals the older entry wins, since the
  // point of the exercise is distance from the thought.
  const scored = eligible
    .map((e) => ({ e, score: cueScore(e) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.e.createdAt - b.e.createdAt);
  if (scored.length > 0) {
    const { text, count } = assemble(scored.map((x) => x.e), budgetChars);
    if (count > 0) return { text, count, cued: true };
  }

  // Nothing scored (or nothing fit): sample evenly across the vault's history
  // instead of taking its oldest corner, so the block spans years if there are
  // years to span.
  const byAge = [...eligible].sort((a, b) => a.createdAt - b.createdAt);
  const wanted = Math.min(RETRO_FALLBACK_PICKS, byAge.length);
  const spread = Array.from({ length: wanted }, (_, i) => byAge[Math.floor((i * byAge.length) / wanted)]);
  const { text, count } = assemble(spread, budgetChars);
  return count > 0 ? { text, count, cued: false } : EMPTY;
}

// ── the opt-in ────────────────────────────────────────────────────────────
//
// Device-local, like the capture quality, the answer limit, the spoken
// language and the theme — never synced, never content. Two reasons, and the
// second is the real one:
//
//   1. sync/engine.ts encodes AiSettings as a whole object, so a field would
//      survive a round-trip — but every synced field is still one more thing an
//      older build can drop, and this one is a consent flag.
//   2. What the consent is ABOUT is what leaves this device. A decision taken on
//      a laptop with a local Ollama should not silently authorize a phone
//      talking to a cloud provider. Asking once per device is the honest
//      granularity, and it is the same reasoning the per-use transcription
//      disclosure follows.
//
// `null` — never asked — is deliberately distinct from 'off': it is what makes
// the consent overlay appear exactly once, on the first AI interview.
const DEEP_KEY = 'mneme.interview.deepReflection';

export type ReflectionChoice = 'on' | 'off' | null;

/** localStorage, or null where it is unavailable (private-mode quirks, a
 *  worker, the headless repro scripts) — never a throw from a getter. */
function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** What the user decided on this device, or null if they have not been asked. */
export function deepReflectionChoice(): ReflectionChoice {
  const raw = store()?.getItem(DEEP_KEY);
  return raw === 'on' || raw === 'off' ? raw : null;
}

/** Whether the interviews may use the two dynamics. Unasked reads as off. */
export function deepReflectionEnabled(): boolean {
  return deepReflectionChoice() === 'on';
}

/** Record the decision. Both answers count as a decision — that is what stops
 *  the overlay coming back — and the toggle in Preferences rewrites it. */
export function setDeepReflection(on: boolean): void {
  try {
    store()?.setItem(DEEP_KEY, on ? 'on' : 'off');
  } catch {
    // A full or blocked store just means we ask again next time.
  }
}
