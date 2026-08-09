// Replace-recovery-phrase sheet — the escape hatch for "my twelve words may
// have leaked". Walks the user through generating a fresh phrase, proving they
// saved it (same quiz pattern as onboarding), then runs the actual rotation
// (sync/rotate.ts) with live progress. The old phrase keeps working until the
// final wipe step, so an interrupted rotation loses nothing.
import type { JSX, VNode } from 'preact';
import { useState } from 'preact/hooks';
import { Icon } from './Icon';
import { Btn } from './primitives';
import { Sheet } from './Sheet';
import { generateMnemonic, mnemonicWords } from '../crypto/mnemonic';
import { ManagerCredential } from '../screens/Onboarding';
import type { RotationProgress } from '../sync/rotate';
import { t, type MessageKey } from '../i18n';

type Step = 'warn' | 'reveal' | 'confirm' | 'working' | 'done' | 'error';

const pStyle: JSX.CSSProperties = { fontFamily: 'var(--ui)', fontSize: 13.5, lineHeight: 1.55, color: 'var(--ink-2)', margin: 0 };

export function RotatePhraseSheet({ desk, onClose, rotate }: {
  desk: boolean;
  onClose: () => void;
  /** Runs the migration; resolves once the vault lives under the new phrase. */
  rotate: (newMnemonic: string, onProgress: (p: RotationProgress) => void) => Promise<void>;
}): VNode {
  const [step, setStep] = useState<Step>('warn');
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [progress, setProgress] = useState<RotationProgress | null>(null);
  const [error, setError] = useState('');
  // Generated once per sheet open; only submitted to rotate() after the quiz.
  const [mnemonic] = useState(() => generateMnemonic());
  const words = mnemonicWords(mnemonic);

  // Confirm quiz (same shape as onboarding): prove three words were written down.
  const quizIdx = [1, 5, 9];
  const [picks, setPicks] = useState<Record<number, string>>({});
  const allCorrect = quizIdx.every((i) => picks[i] === words[i]);
  const decoys = ['lantern', 'meadow', 'cobalt', 'thicket', 'ember', 'harbor', 'walnut', 'prairie', 'quartz'];
  const options = (i: number): string[] => {
    const set = [words[i], decoys[i % decoys.length], decoys[(i + 3) % decoys.length], decoys[(i + 6) % decoys.length]];
    return set.sort((a, b) => (a > b ? 1 : -1));
  };

  const run = async (): Promise<void> => {
    setStep('working');
    setError('');
    try {
      await rotate(mnemonic, setProgress);
      setStep('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  };

  const busy = step === 'working';

  const body = ((): VNode => {
    if (step === 'warn') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={pStyle}>{t('vault.rotate.warn.body')}</p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 14px', borderRadius: 12, background: 'var(--accent-soft)', border: '1px solid var(--accent-line)', fontFamily: 'var(--ui)', fontSize: 12.5, lineHeight: 1.5, color: 'var(--accent-ink)' }}>
            <Icon name="shield" size={16} color="var(--accent)" />
            <span>{t('vault.rotate.warn.callout')}</span>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <Btn kind="ghost" size="md" onClick={onClose} style={{ flex: 1 }}>{t('common.cancel')}</Btn>
            <Btn kind="primary" size="md" onClick={() => setStep('reveal')} style={{ flex: 2 }}>{t('vault.rotate.generate')}</Btn>
          </div>
        </div>
      );
    }

    if (step === 'reveal') {
      return (
        <form onSubmit={(e) => { e.preventDefault(); setStep('confirm'); }} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <ManagerCredential phrase={mnemonic} />
          <p style={pStyle}>{t('vault.rotate.reveal.body')}</p>
          <div style={{ position: 'relative' }}>
            <div style={{ display: 'grid', gridTemplateColumns: desk ? 'repeat(3, 1fr)' : 'repeat(2, 1fr)', gap: 7, padding: 12, borderRadius: 14, background: 'var(--paper)', border: '1px solid var(--line)', filter: revealed ? 'none' : 'blur(7px)', transition: 'filter .2s', userSelect: 'none' }}>
              {words.map((w, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', borderRadius: 9, background: 'var(--surface)', border: '1px solid var(--line)' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', width: 16 }}>{String(i + 1).padStart(2, '0')}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ink)', fontWeight: 500 }}>{w}</span>
                </div>
              ))}
            </div>
            {!revealed && (
              <button type="button" onClick={() => setRevealed(true)} style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 7, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ink)' }}>
                <Icon name="eye" size={20} color="var(--ink)" />
                <span style={{ fontFamily: 'var(--ui)', fontWeight: 600, fontSize: 13.5 }}>{t('vault.rotate.tapToReveal')}</span>
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn kind="ghost" size="sm" icon={revealed ? 'eyeoff' : 'eye'} onClick={() => setRevealed((r) => !r)}>{revealed ? t('vault.rotate.hide') : t('vault.rotate.reveal')}</Btn>
            <Btn kind="ghost" size="sm" icon="copy" onClick={async () => { try { await navigator.clipboard.writeText(mnemonic); } catch { /* clipboard unavailable */ } setCopied(true); setTimeout(() => setCopied(false), 1400); }}>{copied ? t('common.copied') : t('common.copy')}</Btn>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
            <Btn kind="ghost" size="md" onClick={onClose} style={{ flex: 1 }}>{t('common.cancel')}</Btn>
            <Btn kind="primary" size="md" type="submit" style={{ flex: 2 }}>{t('vault.rotate.written')}</Btn>
          </div>
        </form>
      );
    }

    if (step === 'confirm') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={pStyle}>{t('vault.rotate.confirm.body')}</p>
          {quizIdx.map((i) => (
            <div key={i}>
              <div style={{ fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 600, color: 'var(--ink-2)', marginBottom: 7 }}>
                {t('vault.rotate.confirm.word', { num: i + 1 })}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 7 }}>
                {options(i).map((opt) => {
                  const sel = picks[i] === opt;
                  return (
                    <button key={opt} onClick={() => setPicks((p) => ({ ...p, [i]: opt }))} style={{ fontFamily: 'var(--mono)', fontSize: 13.5, fontWeight: 500, padding: '10px 11px', borderRadius: 10, cursor: 'pointer', textAlign: 'start', background: sel ? 'var(--accent-soft)' : 'var(--paper)', border: `1.5px solid ${sel ? 'var(--accent)' : 'var(--line)'}`, color: sel ? 'var(--accent-ink)' : 'var(--ink)' }}>
                      {opt}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
            <Btn kind="ghost" size="md" onClick={() => setStep('reveal')} style={{ flex: 1 }}>{t('common.back')}</Btn>
            <Btn kind={allCorrect ? 'primary' : 'ghost'} size="md" onClick={() => allCorrect && void run()} style={{ flex: 2, opacity: allCorrect ? 1 : 0.55, pointerEvents: allCorrect ? 'auto' : 'none' }}>
              {allCorrect ? t('vault.rotate.now') : t('vault.rotate.selectAll')}
            </Btn>
          </div>
        </div>
      );
    }

    if (step === 'working') {
      const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '12px 0' }}>
          <Icon name="lock" size={26} color="var(--accent)" />
          <div style={{ fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
            {progress ? t(`vault.rotate.phase.${progress.phase}` as MessageKey) : t('vault.rotate.preparing')}
          </div>
          <div style={{ width: '100%', height: 6, borderRadius: 99, background: 'var(--line)', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', borderRadius: 99, background: 'var(--accent)', transition: 'width .25s' }} />
          </div>
          <p style={{ ...pStyle, fontSize: 12.5, textAlign: 'center' }}>{t('vault.rotate.keepOpen')}</p>
        </div>
      );
    }

    if (step === 'done') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '10px 0', textAlign: 'center' }}>
          <Icon name="check" size={28} color="var(--accent)" />
          <div style={{ fontFamily: 'var(--ui)', fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>{t('vault.rotate.done.title')}</div>
          <p style={pStyle}>{t('vault.rotate.done.body')}</p>
          <Btn kind="primary" size="md" full onClick={onClose}>{t('common.done')}</Btn>
        </div>
      );
    }

    // error
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={pStyle}>{t('vault.rotate.error.body')}</p>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)', padding: '10px 12px', borderRadius: 10, background: 'var(--paper)', border: '1px solid var(--line)', overflowWrap: 'anywhere' }}>{error}</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Btn kind="ghost" size="md" onClick={onClose} style={{ flex: 1 }}>{t('common.close')}</Btn>
          <Btn kind="primary" size="md" onClick={() => void run()} style={{ flex: 2 }}>{t('vault.tryAgain')}</Btn>
        </div>
      </div>
    );
  })();

  return (
    <Sheet desk={desk} onClose={busy ? undefined : onClose} scroll title={t('vault.rotate.title')} icon="shield">
      {body}
    </Sheet>
  );
}
