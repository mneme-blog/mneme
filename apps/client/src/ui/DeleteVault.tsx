// Delete-vault sheet — the permanent exit. Wipes the account from the relay and
// erases this device (plaintext DB + at-rest seal), then lands on onboarding.
// Deliberately heavy friction: the user must type the word "delete" — a
// matching server-side check guards the relay endpoint too, so neither a stray
// tap nor a stray request can destroy a vault.
import type { JSX, VNode } from 'preact';
import { useState } from 'preact/hooks';
import { Icon } from './Icon';
import { Btn } from './primitives';
import { Sheet } from './Sheet';
import { TypedConfirmForm } from './ConfirmDialog';
import { t } from '../i18n';

type Step = 'confirm' | 'working' | 'error';

const pStyle: JSX.CSSProperties = { fontFamily: 'var(--ui)', fontSize: 13.5, lineHeight: 1.55, color: 'var(--ink-2)', margin: 0 };

export function DeleteVaultSheet({ desk, onClose, deleteVault }: {
  desk: boolean;
  onClose: () => void;
  /** Performs the wipe; on success the app returns to onboarding (this sheet unmounts). */
  deleteVault: () => Promise<void>;
}): VNode {
  const [step, setStep] = useState<Step>('confirm');
  const [error, setError] = useState('');
  const word = t('vault.delete.word');

  const run = async (): Promise<void> => {
    setStep('working');
    setError('');
    try {
      await deleteVault();
      // Success unmounts the whole unlocked UI (status → locked) — nothing to render here.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    }
  };

  const busy = step === 'working';

  const body = ((): VNode => {
    if (step === 'working') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: '12px 0' }}>
          <Icon name="trash" size={26} color="var(--accent)" />
          <div style={{ fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{t('vault.delete.working')}</div>
          <p style={{ ...pStyle, fontSize: 12.5, textAlign: 'center' }}>
            {t('vault.delete.workingBody')}
          </p>
        </div>
      );
    }

    if (step === 'error') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={pStyle}>{t('vault.delete.error')}</p>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)', padding: '10px 12px', borderRadius: 10, background: 'var(--paper)', border: '1px solid var(--line)', overflowWrap: 'anywhere' }}>{error}</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Btn kind="ghost" size="md" onClick={onClose} style={{ flex: 1 }}>{t('common.close')}</Btn>
            <Btn kind="primary" size="md" onClick={() => void run()} style={{ flex: 2 }}>{t('vault.tryAgain')}</Btn>
          </div>
        </div>
      );
    }

    // confirm
    return (
      <TypedConfirmForm
        word={word}
        label={t('vault.delete.typeToConfirm', { word })}
        confirmLabel={t('vault.delete.forever')}
        idleLabel={t('vault.delete.typeFirst', { word })}
        onConfirm={() => void run()}
        onCancel={onClose}
      >
        <p style={pStyle}>{t('vault.delete.body')}</p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 14px', borderRadius: 12, background: 'var(--accent-soft)', border: '1px solid var(--accent-line)', fontFamily: 'var(--ui)', fontSize: 12.5, lineHeight: 1.5, color: 'var(--accent-ink)' }}>
          <Icon name="trash" size={16} color="var(--accent)" />
          <span>{t('vault.delete.callout')}</span>
        </div>
      </TypedConfirmForm>
    );
  })();

  return (
    <Sheet desk={desk} onClose={busy ? undefined : onClose} scroll title={t('vault.delete.title')} icon="trash">
      {body}
    </Sheet>
  );
}
