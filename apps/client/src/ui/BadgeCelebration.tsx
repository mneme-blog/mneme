// The badge celebration overlay (state/badges.ts): a heavily frosted full-
// screen backdrop — stronger than the dialogs' blur(2px), the mobile tab bar's
// glass idiom — with a centered medallion card. Shown one badge at a time by
// app.tsx (useBadges queues); dismissing marks the badge seen. Also exports
// BadgeMedallion for the gallery in Preferences → Your writing.
import type { VNode } from 'preact';
import { useEffect } from 'preact/hooks';
import type { BadgeId } from '../state/badges';
import { Icon } from './Icon';
import { Btn } from './primitives';
import { Z } from './Sheet';
import { t, type MessageKey } from '../i18n';

export const badgeName = (id: BadgeId): string => t(`badges.${id}.name` as MessageKey);
export const badgeDesc = (id: BadgeId): string => t(`badges.${id}.desc` as MessageKey);

export function BadgeMedallion({ earned, size = 56 }: { earned: boolean; size?: number }): VNode {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: earned ? 'var(--accent-soft)' : 'var(--surface-2)',
        boxShadow: earned ? '0 0 0 3px var(--accent-line)' : '0 0 0 1px var(--line)',
        // Locked badges sit dimmed and colorless in the gallery.
        opacity: earned ? 1 : 0.38,
        filter: earned ? undefined : 'grayscale(1)',
      }}
    >
      <Icon name="award" size={Math.round(size * 0.48)} color={earned ? 'var(--accent-ink)' : 'var(--ink-3)'} />
    </span>
  );
}

export function BadgeCelebration({ id, onDismiss }: { id: BadgeId; onDismiss: () => void }): VNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <div
      role="dialog"
      aria-label={t('badges.celebrate.title')}
      onClick={onDismiss}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: Z.celebration, // above the Lightbox — a celebration tops everything
        background: 'var(--surface-glass)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 18,
      }}
    >
      <div
        class="mneme-badge-pop"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 340,
          maxWidth: '100%',
          boxSizing: 'border-box',
          background: 'var(--surface)',
          borderRadius: 20,
          border: '1px solid var(--line)',
          padding: '28px 24px 22px',
          boxShadow: '0 20px 60px rgba(30,20,12,.3)',
          textAlign: 'center',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
          <BadgeMedallion earned size={72} />
        </div>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            letterSpacing: '.14em',
            textTransform: 'uppercase',
            color: 'var(--accent-ink)',
            marginBottom: 6,
          }}
        >
          {t('badges.celebrate.title')}
        </div>
        <h3 style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, color: 'var(--ink)', margin: '0 0 8px' }}>
          {badgeName(id)}
        </h3>
        <p style={{ fontFamily: 'var(--ui)', fontSize: 13.5, lineHeight: 1.55, color: 'var(--ink-2)', margin: '0 0 20px' }}>
          {badgeDesc(id)}
        </p>
        <Btn kind="primary" full onClick={onDismiss}>
          {t('badges.celebrate.dismiss')}
        </Btn>
      </div>
    </div>
  );
}
