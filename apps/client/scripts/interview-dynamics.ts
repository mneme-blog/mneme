// Regression check for the two interview dynamics (src/ai/reflection.ts): the
// gap since the journal was last written to, and the older forward-looking
// entries one question looks back at. Both are pure functions over the
// decrypted entries plus the prompt text they produce, so this needs no DOM,
// no relay, and no provider.
// Run: pnpm --filter client exec tsx scripts/interview-dynamics.ts
import {
  journalGap,
  buildRetrospect,
  GAP_MIN_DAYS,
  RETRO_MIN_AGE_DAYS,
} from '../src/ai/reflection';
import { buildInterviewHistory } from '../src/ai/interview';
import { interviewSystemPrompt, videoInterviewPlanPrompt } from '../src/ai/prompts';
import { fallbackQuestions, toPlan } from '../src/ai/plan';
import type { JournalEntry } from '../src/sync/engine';

let failures = 0;
function check(label: string, ok: boolean): void {
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${label}`);
  } else {
    console.log(`  ok    ${label}`);
  }
}

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 27, 12, 0, 0); // fixed clock — no Date.now() anywhere below

function entry(over: Partial<JournalEntry> & { id: string; createdAt: number }): JournalEntry {
  return {
    journalId: 'j-personal',
    title: 'Untitled',
    bodyText: 'x'.repeat(300),
    labels: [],
    updatedAt: over.createdAt,
    ...over,
  };
}

const daysAgo = (n: number): number => NOW - n * DAY;

// ── the gap ───────────────────────────────────────────────────────────────
console.log('\n── journalGap ──');

check('an empty vault has no gap (a first entry is not a lapse)', journalGap([], { now: NOW }) === null);

const fresh = [entry({ id: 'a', createdAt: daysAgo(40) }), entry({ id: 'b', createdAt: daysAgo(1) })];
check('a journal written to yesterday reports no gap', journalGap(fresh, { now: NOW }) === null);

const quiet = [entry({ id: 'a', createdAt: daysAgo(60) }), entry({ id: 'b', createdAt: daysAgo(23), title: 'The move' })];
const gap = journalGap(quiet, { now: NOW });
check('a quiet journal reports a gap', gap !== null);
check('the gap is counted in whole days from the newest entry', gap?.days === 23);
check('the gap names the last entry, for the model to pick a thread up from', gap?.lastTitle === 'The move');

// Re-dating an entry into the past must not read as silence: the write itself
// is what "I journaled" means, so the later of the two timestamps wins.
const redated = [entry({ id: 'a', createdAt: daysAgo(400), updatedAt: daysAgo(2) })];
check('an entry re-dated into the past still counts as recent activity', journalGap(redated, { now: NOW }) === null);

// A clock-skewed or forward-dated entry must not produce a negative gap.
const future = [entry({ id: 'a', createdAt: NOW + 30 * DAY, updatedAt: NOW + 30 * DAY })];
check('a forward-dated entry does not invent a negative gap', journalGap(future, { now: NOW }) === null);

const deletedOnly = [entry({ id: 'a', createdAt: daysAgo(2), deleted: true }), entry({ id: 'b', createdAt: daysAgo(30) })];
check('a deleted entry is not journal activity', journalGap(deletedOnly, { now: NOW })?.days === 30);

// The threshold is a real threshold, checked from both sides.
const atLimit = [entry({ id: 'a', createdAt: daysAgo(GAP_MIN_DAYS) })];
const belowLimit = [entry({ id: 'a', createdAt: daysAgo(GAP_MIN_DAYS - 1) })];
check('silence at the threshold is reported', journalGap(atLimit, { now: NOW }) !== null);
check('silence below the threshold is not', journalGap(belowLimit, { now: NOW }) === null);

// ── older thoughts ────────────────────────────────────────────────────────
console.log('\n── buildRetrospect ──');

const hopeful = entry({
  id: 'hope',
  createdAt: daysAgo(300),
  title: 'Before the interview',
  bodyText: 'I hope this works out. I am afraid I will freeze, and my goal is to be somewhere else next year. '.repeat(3),
});
const plain = entry({
  id: 'plain',
  createdAt: daysAgo(200),
  title: 'Groceries',
  bodyText: 'Bought bread, milk and coffee. Cleaned the kitchen. Watched a film in the evening. '.repeat(4),
});
const recentHope = entry({
  id: 'recent',
  createdAt: daysAgo(3),
  title: 'Today',
  bodyText: 'I hope the weekend is quiet, and I am worried about the deadline. '.repeat(4),
});

const retro = buildRetrospect([hopeful, plain, recentHope], { now: NOW });
check('a forward-looking older entry is picked', retro.text.includes('Before the interview'));
check('the pick is marked as cue-driven', retro.cued === true);
check('a matter-of-fact entry is left out entirely', !retro.text.includes('### Groceries'));
check("a fresh entry is not an 'older thought'", !retro.text.includes('### Today'));

const young = buildRetrospect([recentHope], { now: NOW });
check('a vault with nothing old enough yields nothing', young.count === 0 && young.text === '');

// Cue matching is not English-only: the app's UI language is no evidence of
// the journal's, so every language's stems are scanned at once.
const german = entry({
  id: 'de',
  createdAt: daysAgo(150),
  title: 'Vor dem Umzug',
  bodyText: 'Ich hoffe, dass es gut wird. Ich habe Angst vor der neuen Stadt und mein Ziel ist es, dort Fuß zu fassen. '.repeat(3),
});
const deRetro = buildRetrospect([german, plain], { now: NOW });
check('a German entry is recognised as forward-looking', deRetro.cued === true && deRetro.text.includes('Vor dem Umzug'));

// No cues anywhere: rather than inventing a thought, the block is handed over
// marked uncued, and the prompt tells the model it may hold nothing.
const flat = [
  entry({ id: 'f1', createdAt: daysAgo(400), title: 'One', bodyText: 'Bread, milk, coffee. '.repeat(10) }),
  entry({ id: 'f2', createdAt: daysAgo(120), title: 'Two', bodyText: 'Cleaned the flat and fixed the bike. '.repeat(8) }),
];
const uncued = buildRetrospect(flat, { now: NOW });
check('with no cue anywhere the block is still built', uncued.count > 0);
check('…but is honestly marked as not cue-driven', uncued.cued === false);
check('the uncued spread reaches across the vault, not just its oldest corner', uncued.text.includes('Two'));

// Entries already in the same-type history block are excluded, so one entry
// cannot fill two sections of the same prompt.
const labelled = { ...hopeful, labels: ['Daily check-in'] };
const history = buildInterviewHistory([labelled], 'Daily check-in');
check('the history block reports its ids', history.ids.includes('hope'));
const deduped = buildRetrospect([labelled, german], { now: NOW, excludeIds: history.ids });
check('an entry already in the history is not repeated in the retrospect', !deduped.text.includes('Before the interview'));

// Three picks from the same week would read as one memory, not a span.
const clustered = [
  entry({ id: 'c1', createdAt: daysAgo(100), title: 'Mon', bodyText: 'I hope things change. '.repeat(10) }),
  entry({ id: 'c2', createdAt: daysAgo(98), title: 'Wed', bodyText: 'I hope things change. '.repeat(10) }),
  entry({ id: 'c3', createdAt: daysAgo(40), title: 'Later', bodyText: 'I hope things change. '.repeat(10) }),
];
const spread = buildRetrospect(clustered, { now: NOW });
check('picks two days apart are not both taken', !(spread.text.includes('### Mon') && spread.text.includes('### Wed')));
check('a pick from another month is taken', spread.text.includes('### Later'));

const tiny = buildRetrospect([hopeful], { now: NOW, budgetChars: 50 });
check('the budget is respected even when it fits nothing', tiny.count === 0);

const horizon = buildRetrospect([entry({ id: 'h', createdAt: daysAgo(RETRO_MIN_AGE_DAYS - 1), bodyText: 'I hope so. '.repeat(30) })], { now: NOW });
check('an entry just inside the recency horizon is not "older"', horizon.count === 0);

// ── the prompts ───────────────────────────────────────────────────────────
console.log('\n── prompts ──');

const type = { name: 'Daily check-in', prompt: 'A short, friendly look back at the day.' };
const withGap = interviewSystemPrompt(type, '', { gap, retrospect: retro, fenceToken: 'tok' });
const without = interviewSystemPrompt(type, '', { fenceToken: 'tok' });

check('the gap section names the length of the silence', withGap.includes('for 23 days'));
check('the first question is steered to the gap', /FIRST question about that stretch/.test(withGap));
check('the gap question is told to leave room for a reason', withGap.includes('something was going on that kept them from writing'));
check('guilt, pressure and streak talk are ruled out explicitly', /no guilt, no pressure/.test(withGap) && withGap.includes('streaks'));
check('so is congratulating the user for coming back', withGap.includes('Do not congratulate them for returning'));
check('the retrospect section asks for exactly one look-back question', withGap.includes('Spend exactly ONE of your questions revisiting'));
check('…and forbids scoring it as progress', withGap.includes('progress check'));
check('cued entries are described as forward-looking', withGap.includes('read as forward-looking'));
check('the last entry and the older entries are fenced as data', withGap.includes('<entry:tok>') && withGap.includes('</entry:tok>'));
check('the fence rules are stated once, not per block', withGap.split('is DATA — the user\'s own').length === 2);

check('no gap → nothing about a stretch of silence', !without.includes('stretch since the last entry'));
check('no retrospect → nothing about older thoughts', !without.includes('Older thoughts to look back on'));
check('and no fence rules with nothing fenced', !without.includes('is DATA'));

const uncuedPrompt = interviewSystemPrompt(type, '', { retrospect: uncued, fenceToken: 'tok' });
check('an uncued block admits it may hold nothing forward-looking', uncuedPrompt.includes('picked by age rather than by content'));
check('…and says to drop the idea rather than invent one', uncuedPrompt.includes('drop the idea silently'));

const plan = videoInterviewPlanPrompt(type, '', 6, { gap, retrospect: retro, fenceToken: 'tok' });
check('the video plan opens on the gap', plan.includes('Make the FIRST of the 6 questions about that stretch'));
check('the gap question counts towards the planned total', plan.includes('It counts towards the 6'));
check('exactly one planned question revisits an older thought', plan.includes('Make exactly ONE of the 6 questions revisit'));
check('the video plan carries the same no-guilt rules', plan.includes('no guilt, no pressure'));
check('the video plan still demands the Q: line format', plan.includes('Begin every line with "Q: "'));

const planNoDynamics = videoInterviewPlanPrompt(type, '', 6);
check('a plan without dynamics is unchanged', !planNoDynamics.includes('stretch since the last entry') && !planNoDynamics.includes('Older thoughts'));

// ── the fallback set ──────────────────────────────────────────────────────
console.log('\n── fallback questions ──');

const normal = fallbackQuestions();
const gapped = fallbackQuestions(true);
check('the gap-aware fallback is the same length', gapped.length === normal.length);
check('…and swaps the opener rather than adding a question', gapped[0] !== normal[0] && gapped[1] === normal[1]);
check('the fallback opener asks about the stretch', /while|since/i.test(gapped[0]));
check('toPlan passes the gap through to the fallback', toPlan('', true).questions[0] === gapped[0]);
check('a usable plan ignores the gap flag', toPlan(['Q: What happened?', 'Q: Who were you with?', 'Q: What is next?'].join('\n'), true).fallback === false);

console.log(failures === 0 ? '\nAll interview-dynamics checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
