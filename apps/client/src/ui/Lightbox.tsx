// Fullscreen image viewer: click a photo anywhere in an entry and it maximizes
// here; ←/→ (buttons or keyboard) step through every image of that entry in
// document order. Bytes resolve through the same lazy path as the inline cards.
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { MediaAttachment } from '../sync/engine';
import { t } from '../i18n';
import { useMediaUrl, fmtBytes, type MediaResolver } from './Attachments';
import { Icon } from './Icon';
import { Z } from './Sheet';

// Prev/next keep their physical left/right positions and glyphs even in RTL —
// stepping through an image strip is spatial navigation, not reading order.
function NavButton({ dir, onClick }: { dir: 'left' | 'right'; onClick: () => void }): VNode {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={dir === 'left' ? t('media.lightbox.prev') : t('media.lightbox.next')}
      style={{
        position: 'absolute', top: '50%', transform: 'translateY(-50%)',
        [dir]: 14, width: 44, height: 44, borderRadius: 999, border: 'none',
        background: 'rgba(255,255,255,.12)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', color: '#fff', zIndex: 2,
      }}
    >
      <Icon name={dir} size={20} />
    </button>
  );
}

export function Lightbox({
  items,
  index,
  resolve,
  onNavigate,
  onClose,
}: {
  /** Every image of the entry, in document order. */
  items: MediaAttachment[];
  index: number;
  resolve: MediaResolver;
  onNavigate: (index: number) => void;
  onClose: () => void;
}): VNode | null {
  const att = items[index];
  const many = items.length > 1;
  const prev = (): void => onNavigate((index - 1 + items.length) % items.length);
  const next = (): void => onNavigate((index + 1) % items.length);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && many) prev();
      else if (e.key === 'ArrowRight' && many) next();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, items.length, onClose]);

  if (!att) return null;
  return (
    <div
      role="dialog"
      aria-label={t('media.lightbox.viewer')}
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: Z.lightbox, background: 'rgba(16,11,7,.92)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <button
        onClick={onClose}
        title={t('common.close')}
        style={{ position: 'absolute', top: 'calc(env(safe-area-inset-top, 0px) + 14px)', insetInlineEnd: 14, width: 40, height: 40, borderRadius: 999, border: 'none', background: 'rgba(255,255,255,.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#fff', zIndex: 2 }}
      >
        <Icon name="x" size={18} />
      </button>

      {many && <NavButton dir="left" onClick={prev} />}
      {many && <NavButton dir="right" onClick={next} />}

      <LightboxImage key={att.id} att={att} resolve={resolve} />

      <div
        onClick={(e) => e.stopPropagation()}
        style={{ position: 'absolute', left: 0, right: 0, bottom: 'calc(env(safe-area-inset-bottom, 0px) + 14px)', display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}
      >
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'rgba(255,255,255,.75)', background: 'rgba(0,0,0,.35)', borderRadius: 999, padding: '5px 13px', maxWidth: '82%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {many ? t('media.lightbox.counter', { n: index + 1, total: items.length }) : fmtBytes(att.bytes)}
          {att.name ? ` · ${att.name}` : ''}
        </span>
      </div>
    </div>
  );
}

// Keyed by att.id so navigation resets the per-image load state cleanly.
function LightboxImage({ att, resolve }: { att: MediaAttachment; resolve: MediaResolver }): VNode {
  const { url, failed, retry } = useMediaUrl(att, resolve);
  // Stop clicks on the image from closing the overlay (backdrop clicks do).
  const stop = (e: MouseEvent): void => e.stopPropagation();
  const [hidden, setHidden] = useState(true); // fade in once decoded
  if (url) {
    return (
      <img
        src={url}
        alt={att.name || t('media.noun.image')}
        onClick={stop}
        onLoad={() => setHidden(false)}
        style={{ maxWidth: '94vw', maxHeight: '92vh', objectFit: 'contain', borderRadius: 6, opacity: hidden ? 0 : 1, transition: 'opacity .14s' }}
      />
    );
  }
  return (
    <div onClick={stop} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, color: 'rgba(255,255,255,.8)' }}>
      <Icon name="image" size={26} color="rgba(255,255,255,.8)" />
      {failed ? (
        <button
          onClick={retry}
          style={{ fontFamily: 'var(--ui)', fontSize: 13, fontWeight: 600, color: '#fff', background: 'rgba(255,255,255,.14)', border: 'none', borderRadius: 999, padding: '7px 16px', cursor: 'pointer' }}
        >
          {t('media.retryUnavailable')}
        </button>
      ) : (
        <span style={{ fontFamily: 'var(--ui)', fontSize: 13 }}>{t('common.loading')}</span>
      )}
    </div>
  );
}
