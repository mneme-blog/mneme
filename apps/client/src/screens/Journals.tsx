import type { VNode, ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { t, tp, fmtNumber, type MessageKey } from '../i18n';
import { Icon } from '../ui/Icon';
import { Btn, Cover, SyncBadge, SyncNotice, Spinner } from '../ui/primitives';
import { hexA } from '../ui/color';
import type { CoverPattern, Journal } from '../data/sample';
import type { TemplateRecord } from '../sync/engine';
import { DocPreview } from '../editor/DocPreview';
import { useAppData } from '../state/data';

const JCOLORS = ['#B0563A', '#4E8B85', '#6A6AA0', '#B08A2E', '#5A7BA6', '#6E8B5E', '#8E6A93', '#C06A4A'];
const JCOVERS: CoverPattern[] = ['lines', 'dots', 'grid', 'plain', 'photo'];

export function NewJournalSheet({
  desk,
  templates,
  onClose,
  onCreate,
}: {
  desk: boolean;
  /** Live (non-deleted) entry templates for the "Start from" picker. */
  templates: TemplateRecord[];
  onClose: () => void;
  /** `template` set → also start the journal's first entry from it. */
  onCreate: (j: Journal, template?: TemplateRecord) => void;
}): VNode {
  const [name, setName] = useState('');
  const [color, setColor] = useState(JCOLORS[1]);
  const [cover, setCover] = useState<CoverPattern>('lines');
  const [tpl, setTpl] = useState('blank'); // template id, or 'blank'
  const draft: Journal = { id: 'new', name: name || t('journals.untitled'), subtitle: t('journals.new'), color, cover, count: 0, last: t('journals.justNow') };

  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Cover journal={draft} w={48} h={62} r={9} />
        <div style={{ flex: 1 }}>
          <input
            autoFocus
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            placeholder={t('journals.name.placeholder')}
            style={{ width: '100%', boxSizing: 'border-box', border: 'none', outline: 'none', background: 'transparent', fontFamily: 'var(--serif)', fontSize: 22, color: 'var(--ink)', fontWeight: 500 }}
          />
          <div style={{ height: 1, background: 'var(--line)', marginTop: 4 }} />
        </div>
      </div>

      <Field label={t('journals.field.colour')}>
        <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
          {JCOLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              style={{ width: 30, height: 30, borderRadius: 999, cursor: 'pointer', background: c, border: color === c ? '2.5px solid var(--ink)' : '2.5px solid transparent', outline: `1px solid ${hexA(c, 0.4)}`, outlineOffset: -1 }}
            />
          ))}
        </div>
      </Field>

      <Field label={t('journals.field.cover')}>
        <div style={{ display: 'flex', gap: 8 }}>
          {JCOVERS.map((cv) => (
            <button
              key={cv}
              onClick={() => setCover(cv)}
              style={{ flex: 1, padding: 7, borderRadius: 12, cursor: 'pointer', background: 'var(--paper)', border: `1.5px solid ${cover === cv ? 'var(--accent)' : 'var(--line)'}`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}
            >
              <Cover journal={{ color, cover: cv }} w={28} h={36} r={6} />
              <span style={{ fontFamily: 'var(--ui)', fontSize: 10.5, color: 'var(--ink-2)' }}>{t(`journals.cover.${cv}` as MessageKey)}</span>
            </button>
          ))}
        </div>
      </Field>

      <Field label={t('journals.field.startFrom')}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[{ id: 'blank', label: t('journals.blank') }, ...templates.map((tm) => ({ id: tm.id, label: tm.name || t('journals.untitledTemplate') }))].map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setTpl(id)}
              style={{ fontFamily: 'var(--ui)', fontSize: 13, fontWeight: 600, padding: '8px 13px', borderRadius: 999, cursor: 'pointer', background: tpl === id ? 'var(--accent-soft)' : 'var(--surface)', color: tpl === id ? 'var(--accent-ink)' : 'var(--ink-2)', border: `1px solid ${tpl === id ? 'var(--accent)' : 'var(--line)'}` }}
            >
              {label}
            </button>
          ))}
        </div>
        {(() => {
          // Picking a template shows what the journal's first entry will hold.
          const sel = templates.find((tm) => tm.id === tpl);
          return sel ? (
            <div style={{ marginTop: 10, border: '1px solid var(--line)', borderRadius: 12, background: 'var(--paper)', maxHeight: 150, overflowY: 'auto', overscrollBehavior: 'contain', padding: '10px 14px' }}>
              <DocPreview json={sel.bodyJson} text={sel.bodyText} size={13} />
            </div>
          ) : null;
        })()}
      </Field>

      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
        <Btn kind="ghost" size="md" onClick={onClose} style={{ flex: 1 }}>{t('common.cancel')}</Btn>
        <Btn
          kind="primary"
          size="md"
          onClick={() =>
            onCreate(
              { ...draft, id: 'j-' + Date.now(), name: name || t('journals.untitled'), subtitle: t('journals.new') },
              templates.find((tm) => tm.id === tpl),
            )
          }
          style={{ flex: 2 }}
        >
          {t('journals.create')}
        </Btn>
      </div>
    </div>
  );

  return (
    <div
      onClick={onClose}
      style={{ position: 'absolute', inset: 0, zIndex: 60, background: 'rgba(30,22,16,.34)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: desk ? 'center' : 'flex-end', justifyContent: 'center' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: desk ? 440 : '100%', boxSizing: 'border-box', background: 'var(--surface)', borderRadius: desk ? 20 : '24px 24px 0 0', border: '1px solid var(--line)', padding: desk ? 26 : '20px 22px 30px', boxShadow: '0 20px 60px rgba(30,20,12,.3)' }}
      >
        {!desk && <div style={{ width: 38, height: 4, borderRadius: 9, background: 'var(--line)', margin: '0 auto 16px' }} />}
        <h3 style={{ fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, color: 'var(--ink)', margin: '0 0 18px' }}>{t('journals.new')}</h3>
        {body}
      </div>
    </div>
  );
}

export function EditJournalSheet({
  desk,
  journal,
  onClose,
  onSave,
}: {
  desk: boolean;
  /** The notebook being restyled — seeds the form. */
  journal: Journal;
  onClose: () => void;
  /** Persists the new name/colour/cover; the caller closes the sheet. */
  onSave: (patch: { name: string; color: string; cover: CoverPattern }) => void;
}): VNode {
  const [name, setName] = useState(journal.name);
  const [color, setColor] = useState(journal.color);
  const [cover, setCover] = useState<CoverPattern>(journal.cover);
  const draft: Journal = { ...journal, name: name || t('journals.untitled'), color, cover };

  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Cover journal={draft} w={48} h={62} r={9} />
        <div style={{ flex: 1 }}>
          <input
            autoFocus
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            placeholder={t('journals.name.placeholder')}
            style={{ width: '100%', boxSizing: 'border-box', border: 'none', outline: 'none', background: 'transparent', fontFamily: 'var(--serif)', fontSize: 22, color: 'var(--ink)', fontWeight: 500 }}
          />
          <div style={{ height: 1, background: 'var(--line)', marginTop: 4 }} />
        </div>
      </div>

      <Field label={t('journals.field.colour')}>
        <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
          {JCOLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              style={{ width: 30, height: 30, borderRadius: 999, cursor: 'pointer', background: c, border: color === c ? '2.5px solid var(--ink)' : '2.5px solid transparent', outline: `1px solid ${hexA(c, 0.4)}`, outlineOffset: -1 }}
            />
          ))}
        </div>
      </Field>

      <Field label={t('journals.field.cover')}>
        <div style={{ display: 'flex', gap: 8 }}>
          {JCOVERS.map((cv) => (
            <button
              key={cv}
              onClick={() => setCover(cv)}
              style={{ flex: 1, padding: 7, borderRadius: 12, cursor: 'pointer', background: 'var(--paper)', border: `1.5px solid ${cover === cv ? 'var(--accent)' : 'var(--line)'}`, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}
            >
              <Cover journal={{ color, cover: cv }} w={28} h={36} r={6} />
              <span style={{ fontFamily: 'var(--ui)', fontSize: 10.5, color: 'var(--ink-2)' }}>{t(`journals.cover.${cv}` as MessageKey)}</span>
            </button>
          ))}
        </div>
      </Field>

      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
        <Btn kind="ghost" size="md" onClick={onClose} style={{ flex: 1 }}>{t('common.cancel')}</Btn>
        <Btn
          kind="primary"
          size="md"
          onClick={() => onSave({ name: name.trim() || t('journals.untitled'), color, cover })}
          style={{ flex: 2 }}
        >
          {t('journals.saveChanges')}
        </Btn>
      </div>
    </div>
  );

  return (
    <div
      onClick={onClose}
      style={{ position: 'absolute', inset: 0, zIndex: 60, background: 'rgba(30,22,16,.34)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: desk ? 'center' : 'flex-end', justifyContent: 'center' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: desk ? 440 : '100%', boxSizing: 'border-box', background: 'var(--surface)', borderRadius: desk ? 20 : '24px 24px 0 0', border: '1px solid var(--line)', padding: desk ? 26 : '20px 22px 30px', boxShadow: '0 20px 60px rgba(30,20,12,.3)' }}
      >
        {!desk && <div style={{ width: 38, height: 4, borderRadius: 9, background: 'var(--line)', margin: '0 auto 16px' }} />}
        <h3 style={{ fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, color: 'var(--ink)', margin: '0 0 18px' }}>{t('journals.edit.title')}</h3>
        {body}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ComponentChildren }): VNode {
  return (
    <div>
      <div style={{ fontFamily: 'var(--ui)', fontSize: 11.5, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 9 }}>{label}</div>
      {children}
    </div>
  );
}

function AccountChip(): VNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
      <div style={{ width: 40, height: 40, borderRadius: 999, background: 'linear-gradient(145deg, var(--accent), #8E4128)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 600, flexShrink: 0 }}>V</div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{t('journals.vault')}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="lock" size={11} color="var(--accent)" />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>7f3a · velvet harbor</span>
        </div>
      </div>
    </div>
  );
}

// Per-notebook badge while some of its entries are still in the push outbox —
// so a bulk import shows which notebooks have finished syncing and which haven't.
function SyncingTag(): VNode {
  return (
    <span
      title={t('journals.syncingTag.title')}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--ui)', fontSize: 11.5, fontWeight: 600, color: 'var(--accent-ink)' }}
    >
      <Spinner size={11} /> {t('journals.syncingTag')}
    </span>
  );
}

function JournalCard({ j, onOpen, syncing }: { j: Journal; onOpen: (j: Journal) => void; syncing?: boolean }): VNode {
  return (
    <button
      onClick={() => onOpen(j)}
      style={{ display: 'flex', alignItems: 'center', gap: 14, width: '100%', textAlign: 'start', cursor: 'pointer', padding: 14, borderRadius: 16, background: 'var(--surface)', border: '1px solid var(--line)', transition: 'all .15s' }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = hexA(j.color, 0.5); e.currentTarget.style.transform = 'translateY(-1px)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--line)'; e.currentTarget.style.transform = 'none'; }}
    >
      <Cover journal={j} w={46} h={58} r={9} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 500, color: 'var(--ink)' }}>{j.name}</div>
        <div style={{ fontFamily: 'var(--ui)', fontSize: 13, color: 'var(--ink-2)', marginTop: 1 }}>{j.subtitle}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 7 }}>
          <span style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-3)' }}>{tp('common.entries', j.count)}</span>
          {j.last && <span style={{ width: 3, height: 3, borderRadius: 9, background: 'var(--ink-3)' }} />}
          {j.last && <span style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-3)' }}>{j.last}</span>}
          {syncing && <span style={{ width: 3, height: 3, borderRadius: 9, background: 'var(--ink-3)' }} />}
          {syncing && <SyncingTag />}
        </div>
      </div>
      <Icon name="right" size={18} color="var(--ink-3)" dirFlip />
    </button>
  );
}

export function JournalsScreen({ desk, journals, onOpen, onNew, onEdit, onDelete, onSearch, onSettings, syncing }: { desk: boolean; journals: Journal[]; onOpen: (j: Journal) => void; onNew: () => void; onEdit: (j: Journal) => void; onDelete: (j: Journal) => void; onSearch: () => void; onSettings: () => void; syncing?: boolean }): VNode {
  const { pendingCount, pendingJournalIds } = useAppData();
  // `syncing` (the first-sync pull) shows the download banner; an outbox with
  // records still to push (e.g. straight after a Day One import) shows an upload
  // banner so the screen never looks idle while entries are still leaving.
  const uploading = !syncing && pendingCount > 0;
  const uploadBanner = uploading && (
    <SyncNotice
      title={t('journals.uploading.title')}
      body={tp('journals.uploading.body', pendingCount)}
    />
  );
  if (desk) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--paper)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '26px 34px 18px' }}>
          <div>
            <h1 style={{ fontFamily: 'var(--serif)', fontSize: 30, fontWeight: 500, color: 'var(--ink)', margin: 0 }}>{t('journals.title')}</h1>
            <p style={{ fontFamily: 'var(--ui)', fontSize: 13.5, color: 'var(--ink-3)', margin: '4px 0 0' }}>{t('journals.summary.desk', { notebooks: tp('journals.notebooks', journals.length), entries: tp('common.entries', journals.reduce((a, b) => a + b.count, 0)) })}</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <SyncBadge />
            <SearchBar desk onClick={onSearch} />
            <Btn kind="primary" icon="plus" onClick={onNew}>{t('journals.new')}</Btn>
          </div>
        </div>
        {syncing && <div style={{ padding: '0 34px 14px' }}><SyncNotice /></div>}
        {uploadBanner && <div style={{ padding: '0 34px 14px' }}>{uploadBanner}</div>}
        <div style={{ flex: 1, overflow: 'auto', padding: '8px 34px 34px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
            {journals.map((j) => (
              // A div, not a <button>: the delete control below has to nest inside.
              <div
                key={j.id}
                role="button"
                tabIndex={0}
                onClick={() => onOpen(j)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(j); } }}
                style={{ textAlign: 'start', cursor: 'pointer', borderRadius: 18, overflow: 'hidden', background: 'var(--surface)', border: '1px solid var(--line)', transition: 'all .15s', padding: 0 }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 12px 30px rgba(40,28,18,.1)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'none'; }}
              >
                <div style={{ height: 96, background: hexA(j.color, 0.12), position: 'relative', borderBottom: '1px solid var(--line)' }}>
                  <div style={{ position: 'absolute', inset: 0, backgroundImage: coverBg(j), backgroundSize: coverSize(j.cover) }} />
                  <div style={{ position: 'absolute', insetInlineStart: 0, top: 0, bottom: 0, width: 6, background: j.color }} />
                  <span style={{ position: 'absolute', insetInlineEnd: 12, top: 12, fontFamily: 'var(--mono)', fontSize: 11, color: hexA(j.color, 0.9), background: 'var(--surface)', padding: '2px 8px', borderRadius: 7, border: `1px solid ${hexA(j.color, 0.3)}` }}>{fmtNumber(j.count)}</span>
                </div>
                <div style={{ padding: '14px 16px 16px' }}>
                  <div style={{ fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, color: 'var(--ink)' }}>{j.name}</div>
                  <div style={{ fontFamily: 'var(--ui)', fontSize: 13, color: 'var(--ink-2)', marginTop: 2 }}>{j.subtitle}</div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 9 }}>
                    {pendingJournalIds.has(j.id) ? (
                      <SyncingTag />
                    ) : (
                      <span style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-3)' }}>{j.last ? t('journals.edited', { last: j.last }) : t('journals.noEntriesYet')}</span>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 2, margin: -6 }}>
                      <button
                        title={t('journals.edit.title')}
                        onClick={(e) => { e.stopPropagation(); onEdit(j); }}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', opacity: 0.55 }}
                        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = 'var(--accent-soft)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.55'; e.currentTarget.style.background = 'transparent'; }}
                      >
                        <Icon name="edit" size={15} color="var(--ink-2)" />
                      </button>
                      <button
                        title={t('journals.delete.title')}
                        onClick={(e) => { e.stopPropagation(); onDelete(j); }}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', opacity: 0.55 }}
                        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = 'var(--accent-soft)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.55'; e.currentTarget.style.background = 'transparent'; }}
                      >
                        <Icon name="trash" size={15} color="var(--accent)" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            <button
              onClick={onNew}
              style={{ cursor: 'pointer', borderRadius: 18, minHeight: 210, background: 'transparent', border: '1.5px dashed var(--line)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--ink-3)', transition: 'all .15s' }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent-ink)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--line)'; e.currentTarget.style.color = 'var(--ink-3)'; }}
            >
              <div style={{ width: 44, height: 44, borderRadius: 999, border: '1.5px solid currentColor', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="plus" size={22} /></div>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 600 }}>{t('journals.new')}</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── mobile ──
  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--paper)', paddingBottom: 84 }}>
      <div style={{ padding: 'calc(env(safe-area-inset-top, 0px) + 24px) 20px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <AccountChip />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <SyncBadge />
            <button onClick={onSettings} aria-label={t('common.settings')} style={{ width: 38, height: 38, borderRadius: 999, border: '1px solid var(--line)', background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
              <Icon name="settings" size={19} color="var(--ink-2)" />
            </button>
          </div>
        </div>

        <h1 style={{ fontFamily: 'var(--serif)', fontSize: 32, fontWeight: 500, color: 'var(--ink)', margin: '24px 0 2px' }}>{t('journals.title')}</h1>
        <p style={{ fontFamily: 'var(--ui)', fontSize: 13.5, color: 'var(--ink-3)', margin: 0 }}>{t('journals.summary.mobile', { notebooks: tp('journals.notebooks', journals.length) })}</p>

        <div style={{ margin: '18px 0' }}><SearchBar onClick={onSearch} /></div>

        {syncing && <div style={{ margin: '0 0 14px' }}><SyncNotice /></div>}
        {uploadBanner && <div style={{ margin: '0 0 14px' }}>{uploadBanner}</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
          {journals.map((j) => <JournalCard key={j.id} j={j} onOpen={onOpen} syncing={pendingJournalIds.has(j.id)} />)}
          <button
            onClick={onNew}
            style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', cursor: 'pointer', padding: 16, borderRadius: 16, background: 'transparent', border: '1.5px dashed var(--line)', color: 'var(--ink-3)' }}
          >
            <div style={{ width: 46, height: 46, borderRadius: 11, border: '1.5px dashed currentColor', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon name="plus" size={22} /></div>
            <div style={{ textAlign: 'start' }}>
              <div style={{ fontFamily: 'var(--ui)', fontSize: 15, fontWeight: 600, color: 'var(--ink)' }}>{t('journals.new')}</div>
              <div style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--ink-3)' }}>{t('journals.newHint')}</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

function SearchBar({ desk, onClick }: { desk?: boolean; onClick: () => void }): VNode {
  return (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: desk ? '8px 14px' : '11px 14px', borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--line)', width: desk ? 220 : '100%', boxSizing: 'border-box', cursor: 'text', textAlign: 'start' }}>
      <Icon name="search" size={17} color="var(--ink-3)" />
      <span style={{ fontFamily: 'var(--ui)', fontSize: 13.5, color: 'var(--ink-3)' }}>{t('journals.searchAll')}</span>
    </button>
  );
}

function coverBg(j: Journal): string {
  const c = j.color;
  const p: Record<CoverPattern, string> = {
    lines: `repeating-linear-gradient(0deg, ${hexA(c, 0)} 0 9px, ${hexA(c, 0.14)} 9px 10px)`,
    dots: `radial-gradient(${hexA(c, 0.26)} 1.5px, transparent 1.6px)`,
    grid: `linear-gradient(${hexA(c, 0.14)} 1px, transparent 1px), linear-gradient(90deg, ${hexA(c, 0.14)} 1px, transparent 1px)`,
    plain: 'none',
    photo: `repeating-linear-gradient(135deg, ${hexA(c, 0.16)} 0 8px, ${hexA(c, 0.05)} 8px 16px)`,
  };
  return p[j.cover];
}
function coverSize(cover: CoverPattern): string {
  return cover === 'dots' || cover === 'grid' ? '11px 11px' : 'auto';
}
