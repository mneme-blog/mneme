import type { VNode } from 'preact';
import { t, tp, fmtDate } from '../i18n';
import { Icon } from '../ui/Icon';
import { Cover, ConnChip, SyncNotice } from '../ui/primitives';
import type { Journal } from '../data/sample';
import { useAppData } from '../state/data';
import { EntryThumbs, entryImages } from '../ui/EntryThumbs';
import { listDate, monthKey } from '../ui/entryDates';


// Mobile-only drill-in: the entries of one notebook. Desktop never routes here —
// it shows the journal-scoped list as the editor's left pane instead.
export function JournalEntriesScreen({ journal, onBack, onOpenEntry, onNew, onEdit, onDelete, syncing }: {
  journal: Journal;
  onBack: () => void;
  onOpenEntry: (id: string) => void;
  onNew: () => void;
  /** Opens the rename/recolour sheet for this notebook. */
  onEdit: () => void;
  /** Opens the typed-"delete" confirmation sheet for this notebook. */
  onDelete: () => void;
  syncing?: boolean;
}): VNode {
  const { entries, mediaThumb } = useAppData();
  const list = entries
    .filter((e) => e.journalId === journal.id)
    .sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--paper)', paddingBottom: 110 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'calc(env(safe-area-inset-top, 0px) + 16px) 14px 0' }}>
        <button onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: 3, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--accent-ink)', fontFamily: 'var(--ui)', fontSize: 15, fontWeight: 600, padding: '6px 4px' }}>
          <Icon name="left" size={22} color="var(--accent-ink)" dirFlip /> {t('journals.title')}
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <ConnChip compact />
          <button title={t('journals.edit.title')} onClick={onEdit} style={{ width: 36, height: 36, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', cursor: 'pointer' }}>
            <Icon name="edit" size={18} color="var(--ink-2)" />
          </button>
          <button title={t('journals.delete.title')} onClick={onDelete} style={{ width: 36, height: 36, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', cursor: 'pointer' }}>
            <Icon name="trash" size={18} color="var(--accent)" />
          </button>
          <button title={t('journals.newEntry')} onClick={onNew} style={{ width: 36, height: 36, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', cursor: 'pointer' }}>
            <Icon name="plus" size={20} color="var(--accent-ink)" />
          </button>
        </div>
      </div>

      <div style={{ padding: '14px 20px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Cover journal={journal} w={46} h={58} r={9} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 500, color: 'var(--ink)', margin: 0 }}>{journal.name}</h1>
            <p style={{ fontFamily: 'var(--ui)', fontSize: 13, color: 'var(--ink-3)', margin: '2px 0 0' }}>
              {journal.last
                ? t('journals.entriesEditedLast', { entries: tp('common.entries', list.length), last: journal.last })
                : tp('common.entries', list.length)}
            </p>
          </div>
        </div>

        {syncing && list.length === 0 && <div style={{ margin: '18px 0 0' }}><SyncNotice /></div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: '18px 0' }}>
          {(() => {
            let lastMonth = '';
            return list.flatMap((e) => {
              const d = new Date(e.createdAt);
              const images = entryImages(e);
              const key = monthKey(d);
              const sep = key !== lastMonth;
              lastMonth = key;
              return [
                sep && (
                  <div key={`m-${key}`} style={{ padding: '16px 2px 4px' }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>
                      {fmtDate(d, { month: 'long', year: 'numeric' })}
                    </span>
                  </div>
                ),
                <button
                  key={e.id}
                  onClick={() => onOpenEntry(e.id)}
                  style={{ textAlign: 'start', cursor: 'pointer', padding: '13px 15px', borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--line)', borderInlineStart: `3px solid ${journal.color}` }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                    <span style={{ fontFamily: 'var(--serif)', fontSize: 16.5, fontWeight: 500, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.title || t('common.untitled')}</span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', flexShrink: 0 }}>{listDate(d)}</span>
                  </div>
                  {e.bodyText && (
                    <p style={{ fontFamily: 'var(--ui)', fontSize: 13, color: 'var(--ink-2)', margin: '4px 0 0', lineHeight: 1.45, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{e.bodyText}</p>
                  )}
                  <EntryThumbs images={images} resolve={(att) => mediaThumb(e.id, att)} size={40} />
                </button>,
              ];
            });
          })()}

          {list.length === 0 && !syncing && (
            <button
              onClick={onNew}
              style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', cursor: 'pointer', padding: 16, borderRadius: 16, background: 'transparent', border: '1.5px dashed var(--line)', color: 'var(--ink-3)' }}
            >
              <div style={{ width: 46, height: 46, borderRadius: 11, border: '1.5px dashed currentColor', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon name="feather" size={20} /></div>
              <div style={{ textAlign: 'start' }}>
                <div style={{ fontFamily: 'var(--ui)', fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>{t('journals.firstEntry')}</div>
                <div style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--ink-3)' }}>{t('journals.firstEntry.hint')}</div>
              </div>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
