// Shared recovery-phrase presentation: the blurred 12-word grid with its
// tap-to-reveal cover, the reveal/copy button row, and the 3-word decoy quiz.
// Used by onboarding (create step) and the rotate-phrase sheet, which differ
// only in sizing/tone (`compact` — the sheet variant is smaller and swaps the
// paper/surface backgrounds) and i18n copy (passed as message keys). The
// phrase handling itself must stay identical in both places, so it lives here
// once. Reveal and quiz-pick state stay in the callers: onboarding keeps the
// phrase revealed when the user comes Back from the confirm step, which only
// works if the state outlives this component.
import type { JSX, VNode } from 'preact';
import { useState } from 'preact/hooks';
import { Icon } from './Icon';
import { Btn } from './primitives';
import { t, type MessageKey } from '../i18n';

// One decoy vocabulary for every quiz (was two hand-maintained arrays that had
// already diverged). None of these needs to be outside the BIP39 wordlist —
// quizOptions skips any decoy that happens to equal the word being quizzed.
const DECOYS = [
  'cedar', 'gravel', 'maple', 'signal', 'orchid', 'pewter', 'driftwood', 'saffron', 'copper',
  'lantern', 'meadow', 'cobalt', 'thicket', 'ember', 'harbor', 'walnut', 'prairie', 'quartz',
];

/**
 * Four answer options for quiz position `i`: the real word plus three decoys,
 * alphabetically sorted so the real word's position carries no signal.
 * Deterministic (no RNG — options must not reshuffle on re-render), and decoys
 * equal to the real word are skipped so the four options are always distinct.
 */
export function quizOptions(words: string[], i: number): string[] {
  const set = [words[i]];
  for (let k = 0; set.length < 4 && k < DECOYS.length; k++) {
    const d = DECOYS[(i * 3 + k) % DECOYS.length];
    if (d !== words[i] && !set.includes(d)) set.push(d);
  }
  return set.sort((a, b) => (a > b ? 1 : -1));
}

/** True once every quizzed position has the right word picked. */
export function allQuizCorrect(words: string[], quizIdx: number[], picks: Record<number, string>): boolean {
  return quizIdx.every((i) => picks[i] === words[i]);
}

/** The numbered 12-word grid, blurred until revealed, with the tap-to-reveal cover. */
export function PhraseGrid({ desk, words, revealed, onReveal, compact, tapLabel, tapHint, style }: {
  desk: boolean;
  words: string[];
  revealed: boolean;
  onReveal: () => void;
  /** Sheet variant: slightly smaller metrics, paper grid on surface cells. */
  compact?: boolean;
  tapLabel: MessageKey;
  /** Optional second caption line under the tap-to-reveal label. */
  tapHint?: MessageKey;
  style?: JSX.CSSProperties;
}): VNode {
  const c = !!compact;
  return (
    <div style={{ position: 'relative', ...style }}>
      <div
        style={{
          display: 'grid', gridTemplateColumns: desk ? 'repeat(3, 1fr)' : 'repeat(2, 1fr)', gap: c ? 7 : 8,
          padding: c ? 12 : 14, borderRadius: c ? 14 : 16, background: c ? 'var(--paper)' : 'var(--surface)',
          border: '1px solid var(--line)',
          filter: revealed ? 'none' : 'blur(7px)', transition: 'filter .2s', userSelect: 'none',
        }}
      >
        {words.map((w, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: c ? 7 : 8, padding: c ? '7px 10px' : '9px 11px', borderRadius: c ? 9 : 10, background: c ? 'var(--surface)' : 'var(--paper)', border: '1px solid var(--line)' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: c ? 10.5 : 11, color: 'var(--ink-3)', width: 16 }}>{String(i + 1).padStart(2, '0')}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: c ? 13 : 14, color: 'var(--ink)', fontWeight: 500 }}>{w}</span>
          </div>
        ))}
      </div>
      {!revealed && (
        <button
          type="button"
          onClick={onReveal}
          style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: c ? 7 : 8, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ink)' }}
        >
          <Icon name="eye" size={c ? 20 : 22} color="var(--ink)" />
          <span style={{ fontFamily: 'var(--ui)', fontWeight: 600, fontSize: c ? 13.5 : 14 }}>{t(tapLabel)}</span>
          {tapHint && <span style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-2)' }}>{t(tapHint)}</span>}
        </button>
      )}
    </div>
  );
}

/** Reveal/hide toggle + copy-to-clipboard row under the grid. */
export function RevealCopyRow({ revealed, onToggle, phrase, hideLabel, revealLabel, style }: {
  revealed: boolean;
  onToggle: () => void;
  /** The full space-joined phrase — what Copy puts on the clipboard. */
  phrase: string;
  hideLabel: MessageKey;
  revealLabel: MessageKey;
  style?: JSX.CSSProperties;
}): VNode {
  // Transient "Copied" flash; fine to reset if the parent remounts the row.
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: 'flex', gap: 8, ...style }}>
      <Btn kind="ghost" size="sm" icon={revealed ? 'eyeoff' : 'eye'} onClick={onToggle}>{revealed ? t(hideLabel) : t(revealLabel)}</Btn>
      <Btn kind="ghost" size="sm" icon="copy" onClick={async () => { try { await navigator.clipboard.writeText(phrase); } catch { /* clipboard unavailable */ } setCopied(true); setTimeout(() => setCopied(false), 1400); }}>{copied ? t('common.copied') : t('common.copy')}</Btn>
    </div>
  );
}

/** The prove-you-wrote-it-down quiz: one 4-option block per quizzed position. */
export function PhraseQuiz({ words, quizIdx, picks, onPick, compact, wordLabel, style }: {
  words: string[];
  /** Which word positions to quiz (0-based). */
  quizIdx: number[];
  picks: Record<number, string>;
  onPick: (i: number, word: string) => void;
  compact?: boolean;
  /** Per-question heading key; interpolated with `{num}` (1-based position). */
  wordLabel: MessageKey;
  style?: JSX.CSSProperties;
}): VNode {
  const c = !!compact;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: c ? 14 : 16, ...style }}>
      {quizIdx.map((i) => (
        <div key={i}>
          <div style={{ fontFamily: 'var(--ui)', fontSize: c ? 12 : 12.5, fontWeight: 600, color: 'var(--ink-2)', marginBottom: c ? 7 : 8 }}>
            {t(wordLabel, { num: i + 1 })}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: c ? 7 : 8 }}>
            {quizOptions(words, i).map((opt) => {
              const sel = picks[i] === opt;
              return (
                <button
                  key={opt}
                  onClick={() => onPick(i, opt)}
                  style={{
                    fontFamily: 'var(--mono)', fontSize: c ? 13.5 : 14, fontWeight: 500, padding: c ? '10px 11px' : '11px 12px', borderRadius: c ? 10 : 11, cursor: 'pointer',
                    textAlign: 'start', transition: 'all .12s',
                    background: sel ? 'var(--accent-soft)' : c ? 'var(--paper)' : 'var(--surface)',
                    border: `1.5px solid ${sel ? 'var(--accent)' : 'var(--line)'}`,
                    color: sel ? 'var(--accent-ink)' : 'var(--ink)',
                  }}
                >
                  {opt}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
