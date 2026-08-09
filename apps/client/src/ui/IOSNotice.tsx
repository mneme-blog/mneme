import type { VNode } from 'preact';
import { useState } from 'preact/hooks';
import { isIOS, isTauri } from '../platform/shell';
import { t } from '../i18n';
import { Icon } from './Icon';
import { Z } from './Sheet';

// A one-time, dismissible banner shown ONLY to iOS PWA users. iOS clears a web
// app's offline storage after ~7 days of inactivity (a privacy safeguard), which
// matters for a local-first journal — so we tell people up front that their data
// stays recoverable from the encrypted relay. Never shown on Android or desktop
// (they don't evict), nor inside the Tauri shell (its storage is persistent).
// Framed as the security feature it is, not a complaint. See docs/PWA.md.
const DISMISS_KEY = 'mneme.iosNotice.dismissed';
// Dev/preview escape hatch: set localStorage['mneme.iosNotice.force']='1' to see
// the banner on any platform (there's no iPhone in the dev loop). Overrides both
// the platform check and a prior dismissal.
const FORCE_KEY = 'mneme.iosNotice.force';

function shouldShow(): boolean {
  try {
    if (localStorage.getItem(FORCE_KEY) === '1') return true;
    if (localStorage.getItem(DISMISS_KEY) === '1') return false;
  } catch {
    /* storage unavailable (private mode / disabled) — fall through to platform */
  }
  return isIOS() && !isTauri();
}

export function IOSNotice(): VNode | null {
  const [show, setShow] = useState<boolean>(shouldShow);
  if (!show) return null;

  const dismiss = (): void => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* best-effort — worst case it reappears next launch */
    }
    setShow(false);
  };

  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        top: 0,
        insetInlineStart: 0,
        insetInlineEnd: 0,
        zIndex: Z.notice,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        paddingTop: 'calc(9px + env(safe-area-inset-top))',
        paddingBottom: 9,
        paddingInlineStart: 'calc(14px + env(safe-area-inset-left))',
        paddingInlineEnd: 'calc(12px + env(safe-area-inset-right))',
        background: 'var(--surface-2)',
        borderBottom: '1px solid var(--line)',
        boxShadow: '0 2px 10px rgba(0,0,0,.06)',
        fontFamily: 'var(--ui)',
        fontSize: 12.5,
        lineHeight: 1.42,
        color: 'var(--ink-2)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: 'var(--accent)',
          flexShrink: 0,
          marginTop: 5,
        }}
      />
      <span style={{ flex: 1, minWidth: 0 }}>{t('shell.iosNotice.body')}</span>
      <button
        onClick={dismiss}
        aria-label={t('shell.iosNotice.dismiss')}
        style={{
          flexShrink: 0,
          width: 24,
          height: 24,
          display: 'grid',
          placeItems: 'center',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--ink-3)',
          fontSize: 17,
          lineHeight: 1,
          borderRadius: 6,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface)')}
        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
      >
        <Icon name="x" size={15} />
      </button>
    </div>
  );
}
