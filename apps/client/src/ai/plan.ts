// Turning one model response into a usable list of interview questions.
//
// The video interview plans every question up front (the model never hears a
// recorded answer, so there is nothing to adapt to mid-session). That makes
// this parse the single point where a bad response can ruin a whole recording
// session — so it is deliberately forgiving about format and strict about
// usability, and it always has somewhere to land: below PLAN_MIN usable
// questions, the caller gets the built-in fallback set instead of an error.
//
// Line-prefixed output rather than JSON is a deliberate choice: the AiProvider
// abstraction has no tool-calling and no JSON mode, and small local models are
// markedly more reliable at lines than at valid JSON.
import { t } from '../i18n';

export const PLAN_MIN = 3;
export const PLAN_TARGET = 6;
export const PLAN_MAX = 8;

/** Shortest/longest a question may be to survive the parse. */
const MIN_CHARS = 8;
const MAX_CHARS = 240;

// A line the model marked as a question: "Q:", "Q.", "Q)", "Q -".
const Q_LINE = /^\s*Q\s*[:.)\-–—]\s*/i;
// Leading list markers: "1.", "1)", "-", "*", "•", "–".
const LIST_MARKER = /^\s*(?:\d+\s*[.)\]]|[-*•–—])\s*/;
// Wrapping quotes of every flavour the models reach for.
const WRAPPED = /^["'“”„«»‘’]+|["'“”„«»‘’]+$/g;

function clean(line: string): string {
  return line.replace(Q_LINE, '').replace(LIST_MARKER, '').replace(WRAPPED, '').trim();
}

/**
 * Extract the questions from a raw model response. Tolerates a chatty preamble,
 * numbering, bullets, and quoting; drops lines too short or too long to be a
 * question anyone could answer on camera; collapses near-duplicates; and caps
 * the result at PLAN_MAX. Returns [] when nothing usable came back.
 */
export function parseQuestionPlan(raw: string): string[] {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  // When the model honoured the "Q:" contract, everything else it said is
  // commentary — drop it. Otherwise treat every line as a candidate.
  const marked = lines.filter((l) => Q_LINE.test(l));
  const candidates = marked.length > 0 ? marked : lines;

  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of candidates) {
    const q = clean(line);
    if (q.length < MIN_CHARS || q.length > MAX_CHARS) continue;
    const key = q.toLowerCase().slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }

  // If the response mixes prose with real questions, the question marks tell
  // them apart — but only trust that when enough of them qualify. Note this is
  // `includes`, not `endsWith`: chatty models append a trailing remark
  // ("…grateful? Share the details!") and that line is still a question. It
  // also drops a final line the token limit cut off mid-sentence, which has no
  // question mark at all — worth keeping for that alone.
  const asked = out.filter((q) => q.includes('?'));
  const kept = asked.length >= PLAN_MIN ? asked : out;
  return kept.slice(0, PLAN_MAX);
}

/** The generic set used when the model is unreachable or returns junk. */
export function fallbackQuestions(): string[] {
  return [
    t('assistant.video.fallback.q1'),
    t('assistant.video.fallback.q2'),
    t('assistant.video.fallback.q3'),
    t('assistant.video.fallback.q4'),
    t('assistant.video.fallback.q5'),
  ];
}

export interface QuestionPlan {
  questions: string[];
  /** True when the model's answer was unusable and the built-in set stood in. */
  fallback: boolean;
}

/** Parse a response into a plan, falling back rather than failing. */
export function toPlan(raw: string): QuestionPlan {
  const questions = parseQuestionPlan(raw);
  if (questions.length >= PLAN_MIN) return { questions, fallback: false };
  return { questions: fallbackQuestions(), fallback: true };
}
