// Device-unlock sheet (Preferences → Vault): switch the at-rest seal between
// a passphrase, a WebAuthn security key, and off — while unlocked, without
// re-entering the mnemonic (state/data.tsx holds the seed in memory). The
// previous seal stays in place until the new one succeeds, so a cancelled
// security-key ceremony changes nothing.
import type { JSX, VNode } from 'preact';
import { useState } from 'preact/hooks';
import { Icon, type IconName } from './Icon';
import { Btn } from './primitives';
import { Sheet } from './Sheet';
import { PassField } from './credentials';
import { webauthnAvailable, PrfUnsupportedError } from '../platform/webauthn';
import type { DeviceUnlockChoice } from '../state/data';
import { t, type MessageKey } from '../i18n';

const pStyle: JSX.CSSProperties = { fontFamily: 'var(--ui)', fontSize: 13.5, lineHeight: 1.55, color: 'var(--ink-2)', margin: 0 };

const noManager = { autocomplete: 'off', 'data-1p-ignore': true, 'data-lpignore': 'true' } as const;

const LABEL_KEY: Record<'passphrase' | 'securityKey' | 'off', MessageKey> = {
  passphrase: 'vault.unlock.method.passphrase',
  securityKey: 'vault.unlock.method.securityKey',
  off: 'vault.unlock.method.off',
};

export function DeviceUnlockSheet({ desk, onClose, method, apply }: {
  desk: boolean;
  onClose: () => void;
  /** The seal currently on this device; null → nothing persists. */
  method: 'passphrase' | 'securityKey' | null;
  /** state/data.tsx setDeviceUnlock — rejects when the switch didn't happen. */
  apply: (choice: DeviceUnlockChoice) => Promise<void>;
}): VNode {
  const current = method ?? 'off';
  // 'passphrase' expands the fields below instead of applying immediately.
  const [picked, setPicked] = useState<'passphrase' | null>(null);
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const minLen = 8;
  const passValid = pass1.length >= minLen && pass1 === pass2;
  const mismatch = pass2.length > 0 && pass1 !== pass2;

  const run = (choice: DeviceUnlockChoice): void => {
    if (busy) return;
    setBusy(true);
    setError('');
    setDone('');
    apply(choice)
      .then(() => {
        setBusy(false);
        setPicked(null);
        setPass1('');
        setPass2('');
        setDone(
          t(
            choice.method === 'off'
              ? 'vault.unlock.done.off'
              : choice.method === 'securityKey'
                ? 'vault.unlock.done.securityKey'
                : 'vault.unlock.done.passphrase',
          ),
        );
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(
          t(
            err instanceof PrfUnsupportedError
              ? 'vault.unlock.err.prf'
              : choice.method === 'securityKey'
                ? 'vault.unlock.err.keySetup'
                : 'vault.unlock.err.generic',
          ),
        );
      });
  };

  const Option = ({ icon, kind, note, onClick, active }: {
    icon: IconName;
    kind: 'passphrase' | 'securityKey' | 'off';
    note: string;
    onClick: () => void;
    active: boolean;
  }): VNode => (
    <button
      onClick={onClick}
      disabled={busy}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 12, width: '100%', textAlign: 'start',
        cursor: busy ? 'default' : 'pointer', padding: '12px 14px', borderRadius: 12,
        border: `1.5px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
        background: active ? 'var(--accent-soft)' : 'var(--paper)',
        opacity: busy ? 0.6 : 1,
      }}
    >
      <Icon name={icon} size={17} color={active ? 'var(--accent)' : 'var(--ink-2)'} style={{ marginTop: 1 }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontFamily: 'var(--ui)', fontSize: 13.5, fontWeight: 600, color: active ? 'var(--accent-ink)' : 'var(--ink)' }}>
          {t(LABEL_KEY[kind])}
          {current === kind && <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 500, color: 'var(--ink-3)', marginInlineStart: 8 }}>{t('vault.unlock.current')}</span>}
        </span>
        <span style={{ display: 'block', fontFamily: 'var(--ui)', fontSize: 12, lineHeight: 1.5, color: 'var(--ink-3)', marginTop: 2 }}>{note}</span>
      </span>
    </button>
  );

  return (
    <Sheet desk={desk} onClose={busy ? undefined : onClose} scroll title={t('vault.unlock.title')} icon="key" headerMargin="0 0 12px">
      <p style={pStyle}>{t('vault.unlock.body')}</p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
        {webauthnAvailable() && (
          <Option
            icon="key"
            kind="securityKey"
            note={t('vault.unlock.note.securityKey')}
            active={picked === null && current === 'securityKey'}
            onClick={() => run({ method: 'securityKey' })}
          />
        )}
        <Option
          icon="lock"
          kind="passphrase"
          note={t('vault.unlock.note.passphrase')}
          active={picked === 'passphrase' || (picked === null && current === 'passphrase')}
          onClick={() => setPicked('passphrase')}
        />
        {picked === 'passphrase' && (
          <form
            onSubmit={(e) => { e.preventDefault(); if (passValid) run({ method: 'passphrase', passphrase: pass1 }); }}
            style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '2px 2px 0' }}
          >
            <PassField value={pass1} placeholder={t('vault.unlock.passPlaceholder', { min: minLen })} onInput={setPass1} disabled={busy} noManager={noManager} autoFocus />
            <PassField value={pass2} placeholder={t('vault.unlock.repeatPlaceholder')} onInput={setPass2} disabled={busy} noManager={noManager} />
            {mismatch && <p style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--accent-ink)', margin: '0 2px' }}>{t('vault.unlock.mismatch')}</p>}
            <Btn kind={passValid ? 'primary' : 'ghost'} size="md" full type="submit" style={{ opacity: passValid && !busy ? 1 : 0.55, pointerEvents: passValid && !busy ? 'auto' : 'none' }}>
              {busy ? t('vault.unlock.encrypting') : t('vault.unlock.setPass')}
            </Btn>
          </form>
        )}
        <Option
          icon="shield"
          kind="off"
          note={t('vault.unlock.note.off')}
          active={picked === null && current === 'off'}
          onClick={() => run({ method: 'off' })}
        />
      </div>

      {error && <p style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--accent-ink)', margin: '12px 2px 0' }}>{error}</p>}
      {done && (
        <p style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontFamily: 'var(--ui)', fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-2)', margin: '12px 2px 0' }}>
          <Icon name="check" size={15} color="var(--accent)" style={{ marginTop: 1 }} /> {done}
        </p>
      )}

      <Btn kind="ghost" size="md" full onClick={onClose} style={{ marginTop: 16 }}>{t('common.close')}</Btn>
    </Sheet>
  );
}
