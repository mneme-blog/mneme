// Shared overlay shell: the z-index scale, the dimmed backdrop, and the
// sheet/dialog card that ~25 overlays used to hand-type. Overlays keep their
// deliberate deviations (width, padding, maxHeight…) as props/cardStyle; the
// idiom itself — backdrop, card, grab handle, header row — lives here once.
import type { JSX, VNode, ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';
import { Icon, type IconName } from './Icon';

// ── z-index scale ───────────────────────────────────────────
// Derived from the values the overlays already used; the relative order is the
// contract. Anchored popovers (calendar filter, editor ⋯ menu) put their panel
// one above their click-away backdrop.
export const Z = {
  /** iOS storage notice — floats over content, under every overlay. */
  notice: 35,
  /** Mobile bottom tab bar. */
  nav: 40,
  /** Anchored popover click-away backdrop (+1 for the panel). */
  popover: 40,
  /** Management sheets and inline suggestion lists. */
  sheet: 60,
  /** Editor ⋯ menu click-away (+1 for the panel) — above a sheet it may cover. */
  menu: 65,
  /** Pickers / preferences / capture modals — sheets that stack on other sheets. */
  overlay: 70,
  /** Confirms and modal dialogs — top of the sheet stack. */
  dialog: 80,
  lightbox: 90,
  /** A badge celebration tops everything, the lightbox included. */
  celebration: 95,
} as const;

// Two backdrop tints exist in the wild; both stay.
const DIM = {
  soft: 'rgba(30,22,16,.34)',
  strong: 'rgba(30,22,16,.45)',
} as const;
export type SheetDim = keyof typeof DIM;

export interface SheetBackdropProps {
  /** Omit (or pass undefined while busy) to make the backdrop inert. */
  onClose?: () => void;
  zIndex?: number;
  dim?: SheetDim;
  /** Vertical placement of the child: centered dialog, bottom sheet, or top palette. */
  align?: 'center' | 'bottom' | 'top';
  pad?: number | string;
  role?: JSX.AriaRole;
  'aria-label'?: string;
  /** Merged last — e.g. viewport-pinned geometry for keyboard-aware sheets. */
  style?: JSX.CSSProperties;
  children: ComponentChildren;
}

/**
 * The dimmed full-screen backdrop. Always `position: fixed` — overlays mount
 * deep inside screens (the editor's "/" pickers especially), where no
 * positioned ancestor spans the viewport, so `absolute` silently breaks there.
 *
 * Dismissal is mousedown-tracked: close only on a click that both *starts* and
 * *ends* on the backdrop itself. A plain onClick={onClose} also fires when a
 * press begins inside the card and the release lands on the backdrop (a sloppy
 * click, a text-selection drag, or a click near the card edge) — the browser
 * then dispatches `click` on the common ancestor, which is the backdrop.
 * Tracking the mousedown target closes that gap.
 */
export function SheetBackdrop({ onClose, zIndex = Z.sheet, dim = 'soft', align = 'center', pad = 0, role, style, children, ...rest }: SheetBackdropProps): VNode {
  const pressedOnBackdrop = useRef(false);
  return (
    <div
      role={role}
      aria-label={rest['aria-label']}
      onMouseDown={(e) => { pressedOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (onClose && pressedOnBackdrop.current && e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex,
        background: DIM[dim], backdropFilter: 'blur(2px)',
        display: 'flex',
        alignItems: align === 'bottom' ? 'flex-end' : align === 'top' ? 'flex-start' : 'center',
        justifyContent: 'center',
        padding: pad,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** The 38×4 grab-handle bar atop a mobile bottom sheet. */
export function SheetGrabber({ style }: { style?: JSX.CSSProperties } = {}): VNode {
  return <div style={{ width: 38, height: 4, borderRadius: 9, background: 'var(--line)', margin: '0 auto 16px', ...style }} />;
}

export interface SheetProps {
  /** Centered desktop card (radius 20) vs mobile bottom sheet (radius 24/24/0/0 + grab handle). */
  desk?: boolean;
  /** Centered dialog on BOTH form factors (confirms) — overrides `desk`. */
  center?: boolean;
  /** Omit (or pass undefined while busy) to make the backdrop inert. */
  onClose?: () => void;
  zIndex?: number;
  dim?: SheetDim;
  /** Backdrop padding; defaults to 18 for `center` dialogs, else 0. */
  pad?: number | string;
  /** Card width on desktop / centered; mobile bottom sheets are always full-width. */
  width?: number | string;
  /** Standard header row: serif h3 (optional leading icon) + right-side accessory. */
  title?: ComponentChildren;
  icon?: IconName;
  accessory?: ComponentChildren;
  headerMargin?: string;
  /** Adds the common `maxHeight: 90%` + `overflowY: auto` scroll containment. */
  scroll?: boolean;
  /** Set false for the odd bottom sheet that opens straight into its header. */
  grabber?: boolean;
  /** Per-overlay deviations, merged onto the card last. */
  cardStyle?: JSX.CSSProperties;
  /** Extra card-click behavior (e.g. disarming a pending delete). */
  onCardClick?: () => void;
  role?: JSX.AriaRole;
  backdropStyle?: JSX.CSSProperties;
  children: ComponentChildren;
  footer?: ComponentChildren;
}

export function Sheet({
  desk = false,
  center = false,
  onClose,
  zIndex = Z.sheet,
  dim = 'soft',
  pad,
  width = 460,
  title,
  icon,
  accessory,
  headerMargin = '0 0 16px',
  scroll = false,
  grabber = true,
  cardStyle,
  onCardClick,
  role,
  backdropStyle,
  children,
  footer,
}: SheetProps): VNode {
  const centered = center || desk;
  const card: JSX.CSSProperties = {
    width: centered ? width : '100%',
    maxWidth: center ? '100%' : undefined,
    boxSizing: 'border-box',
    background: 'var(--surface)',
    borderRadius: centered ? 20 : '24px 24px 0 0',
    border: '1px solid var(--line)',
    padding: center ? 22 : desk ? 26 : '20px 22px 30px',
    boxShadow: '0 20px 60px rgba(30,20,12,.3)',
    ...(scroll ? { maxHeight: '90%', overflowY: 'auto' as const } : null),
    ...cardStyle,
  };
  return (
    <SheetBackdrop
      onClose={onClose}
      zIndex={zIndex}
      dim={dim}
      align={centered ? 'center' : 'bottom'}
      pad={pad ?? (center ? 18 : 0)}
      role={role}
      style={backdropStyle}
    >
      <div onClick={(e) => { e.stopPropagation(); onCardClick?.(); }} style={card}>
        {!centered && grabber && <SheetGrabber />}
        {(title != null || accessory != null) && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: headerMargin }}>
            <h3 style={{ fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, color: 'var(--ink)', margin: 0, display: 'flex', alignItems: 'center', gap: 9 }}>
              {icon && <Icon name={icon} size={18} color="var(--accent)" />} {title}
            </h3>
            {accessory}
          </div>
        )}
        {children}
        {footer}
      </div>
    </SheetBackdrop>
  );
}
