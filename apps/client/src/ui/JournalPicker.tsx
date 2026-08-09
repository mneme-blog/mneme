import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t, tp } from '../i18n';
import { Icon } from './Icon';
import { Sheet, Z } from './Sheet';
import type { Journal } from '../data/sample';

// Moving an entry between notebooks. journalId travels inside the encrypted
// entry body (sync/engine.ts) and is persisted by db.putLocal, so a move
// re-files the entry on every device and the relay never learns the grouping.
//
// Two entry points share one sheet: the editor header's journal badge
// (JournalPicker, a click-to-edit chip mirroring EntryDateTime) and the ⋯
// entry-actions menu (which opens JournalSheet directly).

export function JournalPicker({
  journals,
  currentId,
  desk,
  onChange,
}: {
  journals: Journal[];
  currentId: string;
  desk: boolean;
  onChange: (journalId: string) => void;
}): VNode {
  const current = journals.find((j) => j.id === currentId);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        title={t('journals.picker.move')}
        onClick={() => setOpen(true)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', borderRadius: 8, padding: '3px 7px', margin: '-3px -7px', cursor: 'pointer', color: 'var(--ink-3)', transition: 'all .14s' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; e.currentTarget.style.color = 'var(--ink-2)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--ink-3)'; }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 9, background: current?.color ?? 'var(--ink-3)' }} />
        <span style={{ fontFamily: 'var(--ui)', fontSize: 13 }}>{current?.name ?? t('journals.picker.none')}</span>
        <Icon name="down" size={12} />
      </button>
      {open && (
        <JournalSheet
          journals={journals}
          currentId={current?.id}
          desk={desk}
          onClose={() => setOpen(false)}
          onPick={(id) => {
            setOpen(false);
            if (id !== current?.id) onChange(id);
          }}
        />
      )}
    </>
  );
}

export function JournalSheet({
  journals,
  currentId,
  desk,
  onClose,
  onPick,
}: {
  journals: Journal[];
  currentId: string | undefined;
  desk: boolean;
  onClose: () => void;
  onPick: (journalId: string) => void;
}): VNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <Sheet
      desk={desk}
      onClose={onClose}
      zIndex={Z.overlay}
      width={380}
      cardStyle={{ maxHeight: '70vh', overflow: 'auto', padding: desk ? 22 : '18px 22px calc(env(safe-area-inset-bottom, 0px) + 26px)' }}
    >
      <div style={{ fontFamily: 'var(--ui)', fontSize: 11.5, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 12 }}>{t('journals.picker.heading')}</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {journals.map((j) => {
          const active = j.id === currentId;
          return (
            <button
              key={j.id}
              onClick={() => onPick(j.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'start', cursor: 'pointer', padding: '10px 11px', borderRadius: 12, border: '1px solid transparent', background: active ? 'var(--accent-soft)' : 'transparent', transition: 'background .12s' }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--surface-2)'; }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
            >
              <span style={{ width: 12, height: 12, borderRadius: 4, flexShrink: 0, background: j.color }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 600, color: active ? 'var(--accent-ink)' : 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.name}</span>
                <span style={{ display: 'block', fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tp('common.entries', j.count)}</span>
              </span>
              {active && <Icon name="check" size={17} color="var(--accent)" />}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}
