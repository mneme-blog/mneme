// Generic destructive-action confirmation modal — THE confirm dialog (the
// media-delete dialog in Attachments.tsx renders through it too). Use for
// anything that cannot be undone. Also home of TypedConfirmForm, the shared
// type-the-word arming step behind vault and journal deletion.
import type { ComponentChildren, VNode } from 'preact';
import { useState } from 'preact/hooks';
import { Icon, type IconName } from './Icon';
import { Btn } from './primitives';
import { Sheet, Z } from './Sheet';
import { t } from '../i18n';

export function ConfirmDialog({
  icon = 'trash',
  title,
  confirmLabel,
  onCancel,
  onConfirm,
  children,
}: {
  icon?: IconName;
  title: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  children: ComponentChildren;
}): VNode {
  return (
    <Sheet center role="dialog" onClose={onCancel} zIndex={Z.dialog} dim="strong" width={400}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ width: 36, height: 36, borderRadius: 999, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--danger) 12%, transparent)' }}>
          <Icon name={icon} size={17} color="var(--danger)" />
        </span>
        <h3 style={{ fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, color: 'var(--ink)', margin: 0 }}>{title}</h3>
      </div>
      <p style={{ fontFamily: 'var(--ui)', fontSize: 13.5, lineHeight: 1.55, color: 'var(--ink-2)', margin: '0 0 18px' }}>{children}</p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <Btn kind="ghost" onClick={onCancel}>{t('common.cancel')}</Btn>
        <Btn kind="danger" onClick={onConfirm}>{confirmLabel}</Btn>
      </div>
    </Sheet>
  );
}

/**
 * The typed-word arming step for the heaviest deletions: the submit stays
 * disabled until the catalog word is typed (case-insensitive — the friction is
 * deliberate typing, not capitalization). `children` is the lead copy above
 * the input; `label` the "type X to confirm" line, since callers style the
 * embedded word differently.
 */
export function TypedConfirmForm({
  word,
  label,
  confirmLabel,
  idleLabel,
  onConfirm,
  onCancel,
  autoFocus,
  children,
}: {
  /** The localized word to type — the check is purely client-side, so localizing it is safe. */
  word: string;
  label: ComponentChildren;
  /** Submit label once armed. */
  confirmLabel: string;
  /** Submit label while the word hasn't been typed yet. */
  idleLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  autoFocus?: boolean;
  children?: ComponentChildren;
}): VNode {
  const [typed, setTyped] = useState('');
  const armed = typed.trim().toLowerCase() === word.toLowerCase();
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (armed) onConfirm(); }} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {children}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        <span style={{ fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 600, color: 'var(--ink-2)' }}>{label}</span>
        <input
          autoFocus={autoFocus}
          value={typed}
          onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
          placeholder={word}
          autocomplete="off"
          spellcheck={false}
          style={{ fontFamily: 'var(--mono)', fontSize: 14, padding: '10px 12px', borderRadius: 10, border: `1.5px solid ${armed ? 'var(--accent)' : 'var(--line)'}`, background: 'var(--paper)', color: 'var(--ink)', outline: 'none', boxSizing: 'border-box', width: '100%' }}
        />
      </label>
      <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
        <Btn kind="ghost" size="md" onClick={onCancel} style={{ flex: 1 }}>{t('common.cancel')}</Btn>
        <Btn kind={armed ? 'primary' : 'ghost'} size="md" type="submit" style={{ flex: 2, opacity: armed ? 1 : 0.55, pointerEvents: armed ? 'auto' : 'none' }}>
          {armed ? confirmLabel : idleLabel}
        </Btn>
      </div>
    </form>
  );
}
