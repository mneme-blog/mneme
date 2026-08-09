// Generic destructive-action confirmation modal, styled like the media-delete
// dialog in Attachments.tsx. Use for anything that cannot be undone.
import type { ComponentChildren, VNode } from 'preact';
import { Icon, type IconName } from './Icon';
import { Btn } from './primitives';
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
    <div
      role="dialog"
      onClick={onCancel}
      style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(30,22,16,.45)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 400, maxWidth: '100%', boxSizing: 'border-box', background: 'var(--surface)', borderRadius: 20, border: '1px solid var(--line)', padding: 22, boxShadow: '0 20px 60px rgba(30,20,12,.3)' }}
      >
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
      </div>
    </div>
  );
}
