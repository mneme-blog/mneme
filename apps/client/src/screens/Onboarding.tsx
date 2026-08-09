import type { JSX, VNode, ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Icon } from '../ui/Icon';
import { Btn } from '../ui/primitives';
import { Wordmark } from '../ui/Wordmark';
import { generateMnemonic, mnemonicWords, validateMnemonic, wordsToMnemonic } from '../crypto/mnemonic';
import { webauthnAvailable, PrfUnsupportedError } from '../platform/webauthn';
import { APP_VERSION, buildTimeLabel } from '../buildinfo';
import { t, tp, type MessageKey } from '../i18n';
import { ManagerCredential, PassField } from '../ui/credentials';
import type { SealChoice } from '../state/data';

type View = 'welcome' | 'create' | 'confirm' | 'restore' | 'passphrase' | 'unlock';

// Visually hidden but NOT display:none/visibility:hidden, so password-manager
// extensions still see and fill it. 1×1 px + opacity keeps it past their
// viewability heuristics; clip/clip-path would risk failing them.
const managerOnly: JSX.CSSProperties = {
  position: 'absolute', left: 0, top: 0, width: 1, height: 1,
  padding: 0, border: 'none', margin: 0, opacity: 0, pointerEvents: 'none',
  fontSize: 16, // prevent iOS zoom-on-focus if it ever receives focus
};

const hStyle = (desk: boolean): JSX.CSSProperties => ({
  fontFamily: 'var(--serif)', fontWeight: 500, fontSize: desk ? 30 : 26, color: 'var(--ink)', margin: '0 0 6px', letterSpacing: 0.2,
});
const pStyle: JSX.CSSProperties = { fontFamily: 'var(--ui)', fontSize: 14, lineHeight: 1.55, color: 'var(--ink-2)', margin: 0 };

export function Onboarding({ desk, hasVault, unlockMethod, onEnter, onUnlock, onUnlockWithKey }: {
  desk: boolean;
  /** True when a sealed seed exists on this device → start on unlock. */
  hasVault: boolean;
  /** Which factor seals the seed — drives what the unlock view asks for. */
  unlockMethod: 'passphrase' | 'securityKey' | null;
  /** With a `seal` choice the seed is sealed at rest; without, nothing persists.
   * Rejects when the security-key enrollment fails — the view shows it inline. */
  onEnter: (mnemonic: string, seal?: SealChoice) => Promise<void>;
  /** Rejects on a wrong passphrase — the unlock view shows the error inline. */
  onUnlock: (passphrase: string) => Promise<void>;
  /** Runs the WebAuthn ceremony; rejects on cancel / absent key / wrong key. */
  onUnlockWithKey: () => Promise<void>;
}): VNode {
  const [view, setView] = useState<View>(hasVault ? 'unlock' : 'welcome');
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  // A real, freshly generated recovery phrase for this onboarding session.
  const [mnemonic] = useState(() => generateMnemonic());
  const words = mnemonicWords(mnemonic);

  // confirm step
  const quizIdx = [2, 6, 10];
  const [picks, setPicks] = useState<Record<number, string>>({});
  const allCorrect = quizIdx.every((i) => picks[i] === words[i]);
  const decoys = ['cedar', 'gravel', 'maple', 'signal', 'orchid', 'pewter', 'driftwood', 'saffron', 'copper'];
  const options = (i: number): string[] => {
    const set = [words[i], decoys[i % decoys.length], decoys[(i + 3) % decoys.length], decoys[(i + 6) % decoys.length]];
    return set.sort((a, b) => (a > b ? 1 : -1));
  };

  // restore step
  const [restoreWords, setRestoreWords] = useState<string[]>(Array(12).fill(''));
  // Raw text of the visible manager-fill field. Kept as its own state rather than
  // derived from the grid: a join(' ')/tokenize round-trip would swallow the
  // trailing space while someone types a phrase directly into that field.
  const [phraseField, setPhraseField] = useState('');
  const restoreFilled = restoreWords.filter((w) => w.trim()).length;
  const restoreMnemonic = wordsToMnemonic(restoreWords);
  const restoreValid = restoreFilled === 12 && validateMnemonic(restoreMnemonic);

  // Split arbitrary pasted text into mnemonic tokens (whitespace/comma separated, lowercased).
  const tokenize = (text: string): string[] => text.trim().toLowerCase().split(/[\s,]+/).filter(Boolean);

  // Grid edits go through here so the manager-fill field mirrors the grid as one
  // space-separated phrase (managers capture it from there on submit).
  const updateWords = (next: string[]): void => {
    setRestoreWords(next);
    setPhraseField(next.map((w) => w.trim()).filter(Boolean).join(' '));
  };

  // Drop `tokens` into the fields starting at `startIdx`. A multi-word paste fills onward
  // from that position (so pasting a full phrase into field 01 populates all twelve); a
  // single token only touches the field it was dropped into.
  const fillFrom = (startIdx: number, tokens: string[]): void => {
    if (tokens.length === 0) return;
    const next = [...restoreWords];
    for (let k = 0; k < tokens.length && startIdx + k < next.length; k++) next[startIdx + k] = tokens[k];
    updateWords(next);
  };

  const pasteFromClipboard = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText();
      fillFrom(0, tokenize(text));
    } catch {
      /* clipboard unavailable */
    }
  };

  // An edit in the manager-fill field (autofill or typing) replaces the whole grid.
  const syncFromPhrase = (text: string): void => {
    setPhraseField(text);
    const tokens = tokenize(text);
    setRestoreWords(Array.from({ length: 12 }, (_, k) => tokens[k] ?? ''));
  };

  // passphrase step (after create/restore): the phrase that view will hand to
  // onEnter, where it came from (for Back), and the optional device passphrase.
  const [pendingMnemonic, setPendingMnemonic] = useState('');
  const [setupReturn, setSetupReturn] = useState<View>('confirm');
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState(false);
  // Errors are stored as message keys and translated at render time, so an
  // error shown across a locale switch re-renders in the new language.
  const [setupError, setSetupError] = useState<MessageKey | ''>('');

  // unlock step (returning device with a sealed seed)
  const [unlockPass, setUnlockPass] = useState('');
  const [unlockBusy, setUnlockBusy] = useState(false);
  const [unlockError, setUnlockError] = useState<MessageKey | ''>('');

  // Both fields deliberately opt out of password managers: the saved credential
  // for this app is the recovery phrase ("mneme journal"), and a manager
  // offering or capturing the device passphrase here would corrupt that entry.
  const noManager = { autocomplete: 'off', 'data-1p-ignore': true, 'data-lpignore': 'true' } as const;

  const goToPassphrase = (mnemonicToEnter: string, from: View): void => {
    setPendingMnemonic(mnemonicToEnter);
    setSetupReturn(from);
    setView('passphrase');
  };

  const maxW = desk ? 460 : '100%';

  const wrap = (content: ComponentChildren, opts: { top?: boolean } = {}): VNode => (
    <div
      style={{
        height: '100%', width: '100%', boxSizing: 'border-box', background: 'var(--paper)',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: opts.top ? 'flex-start' : 'center',
        position: 'relative', overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: '100%', maxWidth: maxW, boxSizing: 'border-box',
          padding: desk ? '40px 40px' : '78px 26px 30px',
          display: 'flex', flexDirection: 'column', flex: opts.top ? 1 : 'none',
          minHeight: opts.top ? 0 : undefined, overflow: opts.top ? 'auto' : 'visible',
        }}
      >
        {content}
      </div>
      {/* Build provenance on the entry pages (welcome / unlock — the centered
          views); the inner flow steps use the full height, so it stays off them. */}
      {!opts.top && (
        <div style={{ position: 'absolute', bottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)', left: 0, right: 0, textAlign: 'center', fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', pointerEvents: 'none' }}>
          {t('onboarding.build', { version: APP_VERSION, built: buildTimeLabel() })}
        </div>
      )}
    </div>
  );

  // ─────────────── WELCOME ───────────────
  if (view === 'welcome') {
    return wrap(
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 0, margin: 'auto 0' }}>
        <div style={{ marginBottom: 26 }}>
          <svg width="56" height="56" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="9.5" fill="none" stroke="var(--accent)" strokeWidth="1.5" />
            <circle cx="12" cy="12" r="3.4" fill="var(--accent)" />
            <circle cx="12" cy="12" r="9.5" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="2 3.2" opacity="0.4" />
          </svg>
        </div>
        <h1 style={{ fontFamily: 'var(--serif)', fontWeight: 500, fontSize: desk ? 46 : 40, color: 'var(--ink)', margin: 0, letterSpacing: 0.3 }}>Mneme</h1>
        <p style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: desk ? 19 : 17, color: 'var(--ink-2)', margin: '14px 0 0', maxWidth: 320 }}>
          {t('onboarding.tagline')}
        </p>
        <p style={{ fontFamily: 'var(--ui)', fontSize: 13.5, color: 'var(--ink-3)', margin: '10px 0 0', lineHeight: 1.6, maxWidth: 300 }}>
          {t('onboarding.intro')}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: 340, marginTop: 34 }}>
          <Btn kind="primary" size="lg" full onClick={() => setView('create')}>{t('onboarding.startNew')}</Btn>
          <Btn kind="ghost" size="lg" full onClick={() => setView('restore')}>{t('onboarding.haveRecovery')}</Btn>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 30, color: 'var(--ink-3)' }}>
          <Icon name="shield" size={15} color="var(--accent)" />
          <span style={{ fontFamily: 'var(--ui)', fontSize: 12 }}>{t('onboarding.trustLine')}</span>
        </div>
      </div>,
    );
  }

  // ─────────────── CREATE (recovery phrase) ───────────────
  if (view === 'create') {
    return wrap(
      <form
        onSubmit={(e) => { e.preventDefault(); setRevealed(true); setView('confirm'); }}
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' }}
      >
        <ManagerCredential phrase={mnemonic} />
        <BackRow onClick={() => setView('welcome')} step={t('onboarding.step', { current: 1, total: 3 })} />
        <h2 style={hStyle(desk)}>{t('onboarding.create.title')}</h2>
        <p style={pStyle}>
          <strong style={{ color: 'var(--ink)' }}>{t('onboarding.create.lead')}</strong> {t('onboarding.create.body')}
        </p>

        <div style={{ position: 'relative', marginTop: 18 }}>
          <div
            style={{
              display: 'grid', gridTemplateColumns: desk ? 'repeat(3, 1fr)' : 'repeat(2, 1fr)', gap: 8,
              padding: 14, borderRadius: 16, background: 'var(--surface)', border: '1px solid var(--line)',
              filter: revealed ? 'none' : 'blur(7px)', transition: 'filter .2s', userSelect: 'none',
            }}
          >
            {words.map((w, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 11px', borderRadius: 10, background: 'var(--paper)', border: '1px solid var(--line)' }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', width: 16 }}>{String(i + 1).padStart(2, '0')}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--ink)', fontWeight: 500 }}>{w}</span>
              </div>
            ))}
          </div>
          {!revealed && (
            <button
              type="button"
              onClick={() => setRevealed(true)}
              style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ink)' }}
            >
              <Icon name="eye" size={22} color="var(--ink)" />
              <span style={{ fontFamily: 'var(--ui)', fontWeight: 600, fontSize: 14 }}>{t('onboarding.tapToReveal')}</span>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-2)' }}>{t('onboarding.noOneWatching')}</span>
            </button>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <Btn kind="ghost" size="sm" icon={revealed ? 'eyeoff' : 'eye'} onClick={() => setRevealed((r) => !r)}>{revealed ? t('onboarding.hide') : t('onboarding.reveal')}</Btn>
          <Btn kind="ghost" size="sm" icon="copy" onClick={async () => { try { await navigator.clipboard.writeText(words.join(' ')); } catch { /* clipboard unavailable */ } setCopied(true); setTimeout(() => setCopied(false), 1400); }}>{copied ? t('common.copied') : t('common.copy')}</Btn>
        </div>

        <Callout>
          <Icon name="shield" size={16} color="var(--accent)" />
          <span>{t('onboarding.create.callout')}</span>
        </Callout>

        <div style={{ flex: 1 }} />
        <Btn kind="primary" size="lg" full icon="arrowR" type="submit" style={{ marginTop: 16 }}>{t('onboarding.writtenDown')}</Btn>
      </form>,
      { top: true },
    );
  }

  // ─────────────── CONFIRM ───────────────
  if (view === 'confirm') {
    return wrap(
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <BackRow onClick={() => setView('create')} step={t('onboarding.step', { current: 2, total: 3 })} />
        <h2 style={hStyle(desk)}>{t('onboarding.confirm.title')}</h2>
        <p style={pStyle}>{t('onboarding.confirm.body')}</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 20 }}>
          {quizIdx.map((i) => (
            <div key={i}>
              <div style={{ fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--ink-2)', marginBottom: 8 }}>
                {t('onboarding.confirm.word', { num: i + 1 })}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                {options(i).map((opt) => {
                  const sel = picks[i] === opt;
                  return (
                    <button
                      key={opt}
                      onClick={() => setPicks((p) => ({ ...p, [i]: opt }))}
                      style={{
                        fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 500, padding: '11px 12px', borderRadius: 11, cursor: 'pointer',
                        textAlign: 'start', transition: 'all .12s',
                        background: sel ? 'var(--accent-soft)' : 'var(--surface)',
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

        <div style={{ flex: 1 }} />
        <Btn
          kind={allCorrect ? 'primary' : 'ghost'}
          size="lg"
          full
          icon={allCorrect ? 'check' : undefined}
          onClick={() => allCorrect && goToPassphrase(mnemonic, 'confirm')}
          style={{ marginTop: 18, opacity: allCorrect ? 1 : 0.55, pointerEvents: allCorrect ? 'auto' : 'none' }}
        >
          {allCorrect ? t('onboarding.continue') : t('onboarding.confirm.selectAll')}
        </Btn>
      </div>,
      { top: true },
    );
  }

  // ─────────────── RESTORE ───────────────
  if (view === 'restore') {
    return wrap(
      <form
        onSubmit={(e) => { e.preventDefault(); if (restoreValid) goToPassphrase(restoreMnemonic, 'restore'); }}
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' }}
      >
        {/* Account context for password managers; the visible phrase field below is their fill target. */}
        <input type="text" name="username" autocomplete="username" value="mneme journal" readOnly tabIndex={-1} aria-hidden="true" style={managerOnly} />
        {/* Back returns to unlock when this device has a sealed seed (that's where the user came from). */}
        <BackRow onClick={() => setView(hasVault ? 'unlock' : 'welcome')} step={t('onboarding.step.restore')} />
        <h2 style={{ ...hStyle(desk), flexShrink: 0 }}>{t('onboarding.restore.title')}</h2>
        <p style={{ ...pStyle, flexShrink: 0 }}>{t('onboarding.restore.body')}</p>

        {/* Visible so password managers offer the saved phrase on click; filling it spreads the words into the grid. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, padding: '0 12px', height: 42, borderRadius: 10, background: 'var(--surface)', border: '1px solid var(--line)', flexShrink: 0 }}>
          <Icon name="lock" size={15} color="var(--ink-3)" />
          <input
            type="password"
            name="password"
            autocomplete="current-password"
            value={phraseField}
            placeholder={t('onboarding.restore.managerFill')}
            onInput={(e) => syncFromPhrase((e.target as HTMLInputElement).value)}
            style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontFamily: 'var(--mono)', fontSize: 13.5, color: 'var(--ink)' }}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 180px))', gap: 8, marginTop: 12, flex: 1, minHeight: 0, overflowY: 'auto', alignContent: 'start', justifyContent: 'center' }}>
          {restoreWords.map((w, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 11px', borderRadius: 10, height: 42, background: 'var(--surface)', border: `1px solid ${w ? 'var(--accent)' : 'var(--line)'}` }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>{String(i + 1).padStart(2, '0')}</span>
              <input
                value={w}
                placeholder="·····"
                size={1}
                autocomplete="off"
                data-1p-ignore
                data-lpignore="true"
                onInput={(e) => updateWords(restoreWords.map((x, j) => (j === i ? (e.target as HTMLInputElement).value : x)))}
                onPaste={(e) => {
                  const tokens = tokenize(e.clipboardData?.getData('text') ?? '');
                  // A multi-word paste spreads across the fields; let a single word fall
                  // through to the default input handling.
                  if (tokens.length > 1) {
                    e.preventDefault();
                    fillFrom(i, tokens);
                  }
                }}
                style={{ flex: 1, width: '100%', minWidth: 0, border: 'none', outline: 'none', background: 'transparent', fontFamily: 'var(--mono)', fontSize: 13.5, color: 'var(--ink)' }}
              />
            </div>
          ))}
        </div>

        <div style={{ flexShrink: 0 }}>
          <button
            type="button"
            onClick={pasteFromClipboard}
            style={{ alignSelf: 'flex-start', marginTop: 12, background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--accent-ink)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <Icon name="copy" size={14} /> {t('onboarding.restore.paste')}
          </button>

          <Callout>
            <Icon name="lock" size={16} color="var(--accent)" />
            <span>{t('onboarding.restore.callout')}</span>
          </Callout>

          <Btn
            kind={restoreValid ? 'primary' : 'ghost'}
            size="lg"
            full
            type="submit"
            style={{ marginTop: 16, opacity: restoreValid ? 1 : 0.55, pointerEvents: restoreValid ? 'auto' : 'none' }}
          >
            {restoreFilled < 12 ? tp('onboarding.restore.progress', restoreFilled) : restoreValid ? t('onboarding.continue') : t('onboarding.restore.invalid')}
          </Btn>
        </div>
      </form>,
      { top: true },
    );
  }

  // ─────────────── PASSPHRASE (optional at-rest seal) ───────────────
  if (view === 'passphrase') {
    const minLen = 8;
    const valid = pass1.length >= minLen && pass1 === pass2;
    const mismatch = pass2.length > 0 && pass1 !== pass2;
    // Shared tail of the three ways out of this view: run the sign-in, surface
    // a failure inline (a cancelled/unsupported security-key ceremony rejects
    // before any state changes, so staying on the view is safe).
    const enter = (seal?: SealChoice): void => {
      if (busy) return;
      setBusy(true);
      setSetupError('');
      onEnter(pendingMnemonic, seal).catch((err: unknown) => {
        setBusy(false);
        setSetupError(
          err instanceof PrfUnsupportedError
            ? 'onboarding.err.prf'
            : seal?.method === 'securityKey'
              ? 'onboarding.err.keySetup'
              : 'onboarding.err.generic',
        );
      });
    };
    return wrap(
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) enter({ method: 'passphrase', passphrase: pass1 });
        }}
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
      >
        <BackRow onClick={() => !busy && setView(setupReturn)} step={setupReturn === 'confirm' ? t('onboarding.step', { current: 3, total: 3 }) : t('onboarding.step.last')} />
        <h2 style={hStyle(desk)}>{t('onboarding.seal.title')}</h2>
        <p style={pStyle}>
          {t('onboarding.seal.body')}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 18 }}>
          <PassField value={pass1} placeholder={t('onboarding.seal.passPlaceholder', { min: minLen })} onInput={setPass1} disabled={busy} noManager={noManager} />
          <PassField value={pass2} placeholder={t('onboarding.seal.repeatPlaceholder')} onInput={setPass2} disabled={busy} noManager={noManager} />
        </div>
        {mismatch && (
          <p style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--accent-ink)', margin: '8px 2px 0' }}>{t('onboarding.seal.mismatch')}</p>
        )}
        {setupError && (
          <p style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--accent-ink)', margin: '8px 2px 0' }}>{t(setupError)}</p>
        )}

        <Callout>
          <Icon name="shield" size={16} color="var(--accent)" />
          <span>
            {t('onboarding.seal.callout')}
          </span>
        </Callout>

        <div style={{ flex: 1 }} />
        <Btn
          kind={valid ? 'primary' : 'ghost'}
          size="lg"
          full
          type="submit"
          style={{ marginTop: 16, opacity: valid && !busy ? 1 : 0.55, pointerEvents: valid && !busy ? 'auto' : 'none' }}
        >
          {busy ? t('onboarding.seal.encrypting') : t('onboarding.seal.encryptStay')}
        </Btn>
        {webauthnAvailable() && (
          <Btn kind="ghost" size="lg" full icon="key" onClick={() => enter({ method: 'securityKey' })} style={{ marginTop: 10, opacity: busy ? 0.55 : 1, pointerEvents: busy ? 'none' : 'auto' }}>
            {t('onboarding.seal.useKey')}
          </Btn>
        )}
        <Btn kind="ghost" size="lg" full onClick={() => enter()} style={{ marginTop: 10, opacity: busy ? 0.55 : 1, pointerEvents: busy ? 'none' : 'auto' }}>
          {t('onboarding.seal.skip')}
        </Btn>
      </form>,
      { top: true },
    );
  }

  // ─────────────── UNLOCK (returning device with a sealed seed) ───────────────
  const keyUnlock = unlockMethod === 'securityKey';
  const unlockWithKey = (): void => {
    if (unlockBusy) return;
    setUnlockBusy(true);
    setUnlockError('');
    // One message for every failure mode — cancelled ceremony, absent key, or
    // the wrong key (AEAD tag mismatch). The phrase link below is the way out.
    onUnlockWithKey().catch(() => {
      setUnlockBusy(false);
      setUnlockError('onboarding.err.keyUnlock');
    });
  };
  return wrap(
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (keyUnlock || unlockBusy || unlockPass.length === 0) return;
        setUnlockBusy(true);
        setUnlockError('');
        onUnlock(unlockPass).catch(() => {
          setUnlockBusy(false);
          setUnlockPass('');
          setUnlockError('onboarding.err.passUnlock');
        });
      }}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', margin: 'auto 0', width: '100%' }}
    >
      <Wordmark size={24} />
      <div style={{ marginTop: 40, marginBottom: 6, color: 'var(--ink-2)' }}>
        <div style={{ width: 76, height: 76, borderRadius: 999, border: '1.5px solid var(--line)', background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto' }}>
          <Icon name={keyUnlock ? 'key' : 'lock'} size={30} color="var(--accent)" />
        </div>
      </div>
      <h2 style={{ fontFamily: 'var(--serif)', fontSize: 24, color: 'var(--ink)', margin: '18px 0 4px', fontWeight: 500 }}>{t('onboarding.unlock.welcomeBack')}</h2>
      <p style={{ fontFamily: 'var(--ui)', fontSize: 13.5, color: 'var(--ink-3)', margin: 0 }}>
        {keyUnlock ? t('onboarding.unlock.keyHint') : t('onboarding.unlock.passHint')}
      </p>

      <div style={{ width: '100%', maxWidth: 340, marginTop: 26 }}>
        {!keyUnlock && <PassField value={unlockPass} placeholder={t('onboarding.unlock.passPlaceholder')} onInput={setUnlockPass} disabled={unlockBusy} noManager={noManager} autoFocus />}
        {unlockError && (
          <p style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--accent-ink)', margin: '10px 2px 0' }}>{t(unlockError)}</p>
        )}
        {keyUnlock ? (
          <Btn
            kind="primary"
            size="lg"
            full
            icon="key"
            onClick={unlockWithKey}
            style={{ marginTop: 14, opacity: unlockBusy ? 0.55 : 1, pointerEvents: unlockBusy ? 'none' : 'auto' }}
          >
            {unlockBusy ? t('onboarding.unlock.waitingKey') : t('onboarding.unlock.withKey')}
          </Btn>
        ) : (
          <Btn
            kind="primary"
            size="lg"
            full
            type="submit"
            style={{ marginTop: 14, opacity: unlockBusy || unlockPass.length === 0 ? 0.55 : 1, pointerEvents: unlockBusy || unlockPass.length === 0 ? 'none' : 'auto' }}
          >
            {unlockBusy ? t('onboarding.unlock.unlocking') : t('onboarding.unlock.unlock')}
          </Btn>
        )}
      </div>

      <button
        type="button"
        onClick={() => setView('restore')}
        style={{ marginTop: 26, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--accent-ink)', fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 600 }}
      >
        <Icon name="shield" size={18} color="var(--accent-ink)" /> {t('onboarding.unlock.usePhrase')}
      </button>
    </form>,
  );
}

// ── small parts ─────────────────────────────────────────────
function BackRow({ onClick, step }: { onClick: () => void; step?: string }): VNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
      <button type="button" onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ink-2)', fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 600, marginInlineStart: -6 }}>
        <Icon name="left" size={20} dirFlip /> {t('common.back')}
      </button>
      {step && <span style={{ fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 600, color: 'var(--ink-3)', letterSpacing: 0.4 }}>{step}</span>}
    </div>
  );
}

function Callout({ children }: { children: ComponentChildren }): VNode {
  return (
    <div
      style={{
        display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 16, padding: '12px 14px', borderRadius: 12,
        background: 'var(--accent-soft)', border: '1px solid var(--accent-line)',
        fontFamily: 'var(--ui)', fontSize: 12.5, lineHeight: 1.5, color: 'var(--accent-ink)',
      }}
    >
      {children}
    </div>
  );
}
