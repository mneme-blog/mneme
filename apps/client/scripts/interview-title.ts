// Regression check for the AI-interview entry title (guided interview +
// freeform draft): the synthesis prompts ask the model to lead with one "# "
// title line, splitMarkdownTitle lifts it into the entry's title field so the
// saved entry isn't headlined with the date-time default, and the body doc no
// longer contains that line. Drafts without a title line (older output, model
// ignoring the instruction) must fall through untouched so the default-title
// fallback still applies.
// Run: pnpm --filter client exec tsx scripts/interview-title.ts
import { markdownToDoc, splitMarkdownTitle, docToText } from '../src/editor/doc';
import { interviewSynthesisPrompt, freeformDraftPrompt } from '../src/ai/prompts';

let failures = 0;
function check(label: string, ok: boolean): void {
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${label}`);
  } else {
    console.log(`  ok    ${label}`);
  }
}

// ── the happy path: a draft shaped like the prompts ask for ──
const draft = [
  '# A quiet morning walk',
  '',
  '## What happened',
  'I took the long way through the park before work.',
  '',
  '- crisp air',
  '- no phone',
].join('\n');

const split = splitMarkdownTitle(draft);
check('title line is lifted', split.title === 'A quiet morning walk');
check('body no longer starts with the title line', !/^#\s/.test(split.body));
check('body keeps its section heading', split.body.startsWith('## What happened'));
const bodyText = docToText(markdownToDoc(split.body));
check('doc text has no title duplicate', !bodyText.includes('A quiet morning walk'));
check('doc text keeps the content', bodyText.includes('long way through the park'));

// Leading blank lines before the title are tolerated (streamed output).
check('leading blank lines ok', splitMarkdownTitle('\n\n# Title\n\nBody.').title === 'Title');
// Inline emphasis in the title is stripped like everywhere else in this doc path.
check('inline markers stripped', splitMarkdownTitle('# **Bold** _day_\n\nBody.').title === 'Bold day');

// ── the fallbacks: no usable title line → title stays null, body untouched ──
for (const [label, md] of [
  ['section heading is not a title', '## Morning\n\nBody.'],
  ['plain first line is not a title', 'Just a paragraph.\n\nMore.'],
  ['empty title is not a title', '#  \n\nBody.'],
  ['empty draft', ''],
] as const) {
  const s = splitMarkdownTitle(md);
  check(`${label} → null`, s.title === null);
  check(`${label} → body untouched`, s.body === md);
}

// ── the prompts actually ask for the title line ──
check('interview prompt asks for "# " title', interviewSynthesisPrompt({ name: 'Daily' }).includes('"# "'));
check('freeform prompt asks for "# " title', freeformDraftPrompt().includes('"# "'));

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
