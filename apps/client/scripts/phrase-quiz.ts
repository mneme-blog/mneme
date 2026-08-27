// Regression check for the shared recovery-phrase quiz (ui/phrase.tsx),
// extracted from Onboarding + RotatePhrase (finding F8). The quiz gates
// whether a user may proceed with a freshly generated mnemonic, so its edge
// cases matter: options must always include the real word, always be four,
// always be distinct (a decoy equal to the real BIP39 word must be skipped —
// the pre-extraction copies could render duplicate buttons there), and must
// be deterministic (a re-render must not reshuffle the choices).
// Run: pnpm --filter client exec tsx scripts/phrase-quiz.ts
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { quizOptions, allQuizCorrect } from '../src/ui/phrase';

let failures = 0;
function check(label: string, ok: boolean): void {
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${label}`);
  } else {
    console.log(`  ok    ${label}`);
  }
}

const words = ['legal', 'winner', 'thank', 'year', 'wave', 'sausage', 'worth', 'useful', 'legal', 'winner', 'thank', 'yellow'];

// ── Basic contract, across every position an caller might quiz ─────────────
for (const idx of [[2, 6, 10], [1, 5, 9]]) {
  for (const i of idx) {
    const opts = quizOptions(words, i);
    check(`position ${i}: 4 options`, opts.length === 4);
    check(`position ${i}: contains the real word`, opts.includes(words[i]));
    check(`position ${i}: all distinct`, new Set(opts).size === 4);
    check(`position ${i}: alphabetically sorted`, opts.join() === [...opts].sort().join());
  }
}

// ── Determinism: same inputs, same options (no per-render reshuffle) ──────
check(
  'deterministic across calls',
  JSON.stringify(quizOptions(words, 5)) === JSON.stringify(quizOptions(words, 5)),
);

// ── Collision: the real word IS one of the decoys ─────────────────────────
// 'maple', 'signal', 'copper', 'ember' etc. sit in the decoy vocabulary; some
// are also valid BIP39 words a real mnemonic can contain. The options must
// still be 4 distinct entries with the real word present exactly once.
const bip39Decoys = ['maple', 'copper', 'ember', 'harbor', 'walnut', 'gravel', 'cedar', 'orchid', 'meadow', 'cobalt', 'lantern', 'quartz'].filter((w) => wordlist.includes(w));
check('collision fixture is meaningful (some decoys are BIP39 words)', bip39Decoys.length > 0);
for (const decoyWord of bip39Decoys) {
  for (let i = 0; i < 12; i++) {
    const collided = [...words];
    collided[i] = decoyWord;
    const opts = quizOptions(collided, i);
    if (opts.length !== 4 || new Set(opts).size !== 4 || opts.filter((o) => o === decoyWord).length !== 1) {
      check(`collision '${decoyWord}' at ${i}: 4 distinct options, real word once`, false);
    }
  }
}
check('every decoy-collision position yields 4 distinct options', failures === 0);

// ── allQuizCorrect ────────────────────────────────────────────────────────
const quizIdx = [2, 6, 10];
check('no picks → not correct', !allQuizCorrect(words, quizIdx, {}));
check('partial picks → not correct', !allQuizCorrect(words, quizIdx, { 2: words[2], 6: words[6] }));
check('one wrong pick → not correct', !allQuizCorrect(words, quizIdx, { 2: words[2], 6: words[6], 10: 'cedar' }));
check('all right picks → correct', allQuizCorrect(words, quizIdx, { 2: words[2], 6: words[6], 10: words[10] }));
check('extra unrelated picks do not break it', allQuizCorrect(words, quizIdx, { 0: 'x', 2: words[2], 6: words[6], 10: words[10] }));
check('empty quizIdx is vacuously correct', allQuizCorrect(words, [], {}));

if (failures > 0) {
  console.error(`\n${failures} phrase-quiz check(s) FAILED`);
  process.exit(1);
}
console.log('\nall phrase-quiz checks passed');
