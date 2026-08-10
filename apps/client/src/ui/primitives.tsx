import type { JSX, VNode, ComponentChildren } from 'preact';
import { Icon, type IconName } from './Icon';
import { hexA } from './color';
import { labelInfo, type CoverPattern } from '../data/sample';
import { useAppData, type SyncStatus } from '../state/data';
import { t } from '../i18n';

// ── Button ──────────────────────────────────────────────────
type BtnKind = 'primary' | 'ghost' | 'soft' | 'quiet' | 'danger';
type BtnSize = 'sm' | 'md' | 'lg';
interface BtnProps {
  children?: ComponentChildren;
  kind?: BtnKind;
  size?: BtnSize;
  full?: boolean;
  onClick?: () => void;
  style?: JSX.CSSProperties;
  icon?: IconName;
  // Explicit default: inside a <form>, a bare <button> would implicitly be type="submit".
  type?: 'button' | 'submit';
}
export function Btn({ children, kind = 'primary', size = 'md', full, onClick, style = {}, icon, type = 'button' }: BtnProps): VNode {
  const base: JSX.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    fontFamily: 'var(--ui)', fontWeight: 600, cursor: 'pointer', border: '1px solid transparent',
    borderRadius: 12, transition: 'all .15s ease', width: full ? '100%' : undefined, whiteSpace: 'nowrap',
    letterSpacing: 0.1,
  };
  const sizes: Record<BtnSize, JSX.CSSProperties> = {
    sm: { fontSize: 13, padding: '7px 12px', borderRadius: 10 },
    md: { fontSize: 15, padding: '11px 18px' },
    lg: { fontSize: 16, padding: '14px 22px', borderRadius: 14 },
  };
  const kinds: Record<BtnKind, JSX.CSSProperties> = {
    primary: { background: 'var(--accent)', color: '#fff', boxShadow: '0 1px 2px rgba(120,60,30,.25)' },
    ghost: { background: 'transparent', color: 'var(--ink)', border: '1px solid var(--line)' },
    soft: { background: 'var(--accent-soft)', color: 'var(--accent-ink)' },
    quiet: { background: 'transparent', color: 'var(--ink-2)' },
    danger: { background: 'transparent', color: '#B0563A', border: '1px solid var(--line)' },
  };
  return (
    <button
      type={type}
      onClick={onClick}
      style={{ ...base, ...sizes[size], ...kinds[kind], ...style }}
      onMouseEnter={(e) => { e.currentTarget.style.filter = 'brightness(.97)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.filter = 'none'; }}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 16 : 18} />}
      {children}
    </button>
  );
}

// ── Label chip ──────────────────────────────────────────────
export function LabelChip({ id, size = 'md', onRemove }: { id: string; size?: 'sm' | 'md'; onRemove?: () => void }): VNode {
  const L = labelInfo(id);
  const s = size === 'sm';
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontFamily: 'var(--ui)', fontSize: s ? 11.5 : 12.5, fontWeight: 600, letterSpacing: 0.1,
        color: L.color, background: hexA(L.color, 0.1), border: `1px solid ${hexA(L.color, 0.22)}`,
        padding: s ? '2px 8px' : '3px 10px', borderRadius: 999,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 9, background: L.color }} />
      {L.name}
      {onRemove && (
        <button
          title={t('shell.removeLabel', { name: L.name })}
          onClick={onRemove}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 14, height: 14, margin: 0, marginInlineStart: -1, marginInlineEnd: -3, padding: 0,
            background: 'transparent', border: 'none', borderRadius: 999,
            color: L.color, cursor: 'pointer', opacity: 0.65,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.65'; }}
        >
          <Icon name="x" size={s ? 10 : 11} />
        </button>
      )}
    </span>
  );
}

// ── Sync / encryption badge ─────────────────────────────────
// Translate the live sync state into a single human label. `dirty` is the editor's
// local "typed but not yet committed" flag, folded in so the badge reacts the moment
// you start typing — before the debounced save even fires.
interface SyncView {
  label: string;
  dot: string;
  busy: boolean;
  locked: boolean;
  title: string;
}
function deriveSync(status: SyncStatus, pendingCount: number, saving: boolean, dirty: boolean): SyncView {
  if (status === 'connecting') return { label: t('shell.conn.connecting'), dot: 'var(--ink-3)', busy: true, locked: false, title: t('shell.sync.connectingTitle') };
  const unsynced = dirty || saving || pendingCount > 0;
  if (status === 'offline') {
    return unsynced
      ? { label: t('shell.sync.offlineSaved'), dot: '#c98a3c', busy: false, locked: false, title: t('shell.sync.offlineSavedTitle') }
      : { label: t('shell.conn.offline'), dot: 'var(--ink-3)', busy: false, locked: false, title: t('shell.sync.offlineTitle') };
  }
  if (status === 'locked') return { label: t('shell.conn.locked'), dot: 'var(--ink-3)', busy: false, locked: false, title: t('shell.sync.lockedTitle') };
  // online
  if (unsynced) {
    // Surface the outbox depth so a long sync (e.g. just after a bulk import)
    // reads as visible, finite progress rather than an indefinite "Saving…".
    const label = pendingCount > 0 ? t('shell.sync.syncingCount', { count: pendingCount }) : t('shell.sync.saving');
    return { label, dot: 'var(--accent)', busy: true, locked: false, title: t('shell.sync.busyTitle') };
  }
  return { label: t('shell.sync.synced'), dot: 'var(--accent)', busy: false, locked: true, title: t('shell.sync.syncedTitle') };
}

export function SyncBadge({ compact, dirty = false }: { compact?: boolean; dirty?: boolean }): VNode {
  const { status, pendingCount, saving } = useAppData();
  const v = deriveSync(status, pendingCount, saving, dirty);
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 600, color: 'var(--ink-2)',
      }}
      title={v.title}
    >
      {v.locked ? (
        <Icon name="lock" size={14} color="var(--accent)" />
      ) : (
        <span class={v.busy ? 'mneme-pulse' : undefined} style={{ width: 8, height: 8, borderRadius: 9, background: v.dot, flexShrink: 0 }} />
      )}
      {!compact && <span>{v.label}</span>}
    </span>
  );
}

// ── Connection indicator ────────────────────────────────────
// A traffic-light for the relay link, meant to live inline inside a screen header
// (not floating). green = connected · red = offline (auto-retrying) · amber = connecting.
function connColor(s: SyncStatus): string {
  switch (s) {
    case 'online':
      return '#3fa45b';
    case 'offline':
      return '#cc4b37';
    case 'connecting':
      return '#c98a3c';
    default:
      return 'var(--ink-3)';
  }
}
export function connLabel(s: SyncStatus): string {
  switch (s) {
    case 'online':
      return t('shell.conn.online');
    case 'offline':
      return t('shell.conn.offline');
    case 'connecting':
      return t('shell.conn.connecting');
    default:
      return t('shell.conn.locked');
  }
}

export function ConnectionDot({ status, size = 9 }: { status: SyncStatus; size?: number }): VNode {
  return (
    <span
      class={status === 'connecting' ? 'mneme-pulse' : undefined}
      title={connLabel(status)}
      style={{ width: size, height: size, borderRadius: 999, background: connColor(status), flexShrink: 0, display: 'inline-block' }}
    />
  );
}

// Inline header chip: a soft rounded pill (dot + label), or `compact` for just the dot.
export function ConnChip({ compact }: { compact?: boolean }): VNode {
  const { status } = useAppData();
  return (
    <span
      title={connLabel(status)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0,
        padding: compact ? 0 : '4px 10px', borderRadius: 999,
        background: compact ? 'transparent' : 'var(--surface)',
        border: compact ? 'none' : '1px solid var(--line)',
        fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 600, color: 'var(--ink-3)',
      }}
    >
      <ConnectionDot status={status} size={8} />
      {!compact && <span>{connLabel(status)}</span>}
    </span>
  );
}

// ── Loading indicators ──────────────────────────────────────

/** Inline activity spinner: a rotating ring for "work in progress" states. */
export function Spinner({ size = 16, color = 'var(--accent)' }: { size?: number; color?: string }): VNode {
  return (
    <span
      class="mneme-spin"
      style={{
        width: size, height: size, flexShrink: 0, display: 'inline-block', boxSizing: 'border-box',
        borderRadius: 999, border: `2px solid ${color}`, borderTopColor: 'transparent',
      }}
    />
  );
}

/**
 * Sync banner: by default the first-sync notice shown while the initial pull
 * after sign-in is still running, so an empty timeline reads as "still arriving",
 * not "nothing there". `title`/`body` override the copy for the push direction —
 * e.g. while a bulk import's entries are still uploading to the relay.
 */
export function SyncNotice({ title, body }: { title?: string; body?: string } = {}): VNode {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 11, padding: '11px 14px', borderRadius: 12,
        background: 'var(--accent-soft)', border: '1px solid var(--accent-line)',
      }}
    >
      <Spinner size={16} />
      <span style={{ fontFamily: 'var(--ui)', fontSize: 12.5, lineHeight: 1.5, color: 'var(--accent-ink)' }}>
        <strong>{title ?? t('shell.sync.noticeTitle')}</strong>{' '}
        {body ?? t('shell.sync.noticeBody')}
      </span>
    </div>
  );
}

/**
 * Sync progress bar for the main navigation: a thin track that fills as the
 * outbox drains (records done = syncTotal − pendingCount). Renders nothing while
 * the vault is fully synced, so it appears only during an active run (e.g. a bulk
 * import catching up). `flush` drops the rounded corners for a full-bleed edge.
 */
export function SyncProgressBar({ flush = false }: { flush?: boolean } = {}): VNode | null {
  const { status, pendingCount, syncTotal } = useAppData();
  if (status !== 'online' || syncTotal <= 0 || pendingCount <= 0) return null;
  const done = syncTotal - pendingCount;
  const pct = Math.max(3, Math.min(100, (done / syncTotal) * 100));
  return (
    <div
      title={t('shell.sync.progress', { done, total: syncTotal })}
      style={{ height: flush ? 3 : 4, background: 'var(--line)', borderRadius: flush ? 0 : 999, overflow: 'hidden' }}
    >
      <div class="mneme-pulse" style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', borderRadius: 'inherit', transition: 'width .3s ease' }} />
    </div>
  );
}

// ── Journal cover swatch ────────────────────────────────────
export interface CoverSpec {
  color: string;
  cover: CoverPattern;
}
export function Cover({ journal, w = 44, h = 56, r = 8 }: { journal: CoverSpec; w?: number; h?: number; r?: number }): VNode {
  const c = journal.color;
  const patterns: Record<CoverPattern, string> = {
    lines: `repeating-linear-gradient(0deg, ${hexA(c, 0)} 0 7px, ${hexA(c, 0.16)} 7px 8px)`,
    dots: `radial-gradient(${hexA(c, 0.28)} 1.4px, transparent 1.5px)`,
    grid: `linear-gradient(${hexA(c, 0.16)} 1px, transparent 1px), linear-gradient(90deg, ${hexA(c, 0.16)} 1px, transparent 1px)`,
    plain: 'none',
    photo: `repeating-linear-gradient(135deg, ${hexA(c, 0.18)} 0 6px, ${hexA(c, 0.06)} 6px 12px)`,
  };
  const sizes: Partial<Record<CoverPattern, string>> = { dots: '9px 9px', grid: '9px 9px' };
  return (
    <div
      style={{
        width: w, height: h, borderRadius: r, flexShrink: 0, position: 'relative', overflow: 'hidden',
        background: hexA(c, 0.13), backgroundImage: patterns[journal.cover], backgroundSize: sizes[journal.cover],
        border: `1px solid ${hexA(c, 0.3)}`, boxShadow: 'inset 0 0 0 100px transparent',
      }}
    >
      <div style={{ position: 'absolute', insetInlineStart: 0, top: 0, bottom: 0, width: 4, background: c, opacity: 0.85 }} />
    </div>
  );
}
