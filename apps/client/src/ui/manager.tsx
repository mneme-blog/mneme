// Shared atoms of the two record-manager sheets (Templates, InterviewTypes).
// After the overlay shell landed, what remained duplicated between them was
// this handful of verbatim pieces — extracted as atoms rather than a scaffold
// component: the two sheets' list layouts differ genuinely (master/detail +
// accordion vs. a flat list), and a scaffold big enough to host both would
// need more injection points than it saved.
import type { VNode } from 'preact';
import { Icon } from './Icon';
import { t, type MessageKey } from '../i18n';

/** stopPropagation wrapper: the sheet container disarms a pending two-tap
 *  delete on any click that bubbles to it — row actions must not count. */
export const stopRow = (fn: () => void) => (e: Event) => {
  e.stopPropagation();
  fn();
};

/** The "built-in" origin chip. The catalog key is per-sheet on purpose —
 *  the two surfaces may diverge in wording without touching this component. */
export function BuiltinChip({ labelKey }: { labelKey: MessageKey }): VNode {
  return <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', border: '1px solid var(--line)', borderRadius: 6, padding: '1px 6px', flexShrink: 0 }}>{t(labelKey)}</span>;
}

/** The dashed create-new row under the list. */
export function NewRecordButton({ label, onClick }: { label: string; onClick: () => void }): VNode {
  return (
    <button
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '11px 0', borderRadius: 12, border: '1.5px dashed var(--line)', background: 'transparent', cursor: 'pointer', color: 'var(--ink-3)', fontFamily: 'var(--ui)', fontSize: 13.5, fontWeight: 600 }}
    >
      <Icon name="plus" size={16} /> {label}
    </button>
  );
}

/** The header's back-to-list link shown while the editor view is open. */
export function BackToListAccessory({ label, title, onClick }: { label: string; title: string; onClick: () => void }): VNode {
  return (
    <button onClick={onClick} title={title} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ink-3)', display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'var(--ui)', fontSize: 12.5 }}>
      <Icon name="left" size={15} dirFlip /> {label}
    </button>
  );
}

/** The manager sheets' shared card padding (desktop card / mobile safe-area). */
export function managerPadding(desk: boolean): string {
  return desk ? '26px' : '20px 22px calc(env(safe-area-inset-bottom, 0px) + 30px)';
}
