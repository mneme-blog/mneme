// Interview-types manager: list every guided-interview type (built-in seeds and
// user-created alike — built-ins are ordinary records the user may rewrite or
// delete) and edit them. A type is just a name, a one-line intro, and a prompt
// (the question strategy the AI follows), so this is plain text fields — no rich
// editor like the template manager. Mirrors ui/Templates.tsx structurally.
import type { JSX, VNode } from 'preact';
import { useState } from 'preact/hooks';
import { Icon } from './Icon';
import { Btn } from './primitives';
import { Sheet, Z } from './Sheet';
import { BuiltinChip, BackToListAccessory, NewRecordButton, managerPadding, stopRow } from './manager';
import { t } from '../i18n';
import { useAppData } from '../state/data';
import type { InterviewType } from '../sync/engine';

const UI_13 = { fontFamily: 'var(--ui)', fontSize: 13 } as const;
const labelStyle: JSX.CSSProperties = { fontFamily: 'var(--ui)', fontSize: 11.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--ink-3)', display: 'block', marginBottom: 5 };
const fieldStyle: JSX.CSSProperties = { width: '100%', boxSizing: 'border-box', fontFamily: 'var(--ui)', fontSize: 14, color: 'var(--ink)', padding: '10px 12px', borderRadius: 10, background: 'var(--paper)', border: '1px solid var(--line)', outline: 'none' };

function EditorView({ type, onDone }: { type: InterviewType | null; onDone: () => void }): VNode {
  const { createInterviewType, updateInterviewType } = useAppData();
  const [name, setName] = useState(type?.name ?? '');
  const [intro, setIntro] = useState(type?.intro ?? '');
  const [prompt, setPrompt] = useState(type?.prompt ?? '');

  const save = (): void => {
    const input = { name: name.trim() || t('assistant.types.untitled'), intro: intro.trim(), prompt: prompt.trim() };
    if (type) updateInterviewType(type.id, input);
    else createInterviewType(input);
    onDone();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <label style={labelStyle}>{t('assistant.types.name')}</label>
        <input autoFocus={!type} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder={t('assistant.types.namePlaceholder')} style={fieldStyle} />
      </div>
      <div>
        <label style={labelStyle}>{t('assistant.types.intro')}</label>
        <input value={intro} onInput={(e) => setIntro((e.target as HTMLInputElement).value)} placeholder={t('assistant.types.introPlaceholder')} style={fieldStyle} />
      </div>
      <div>
        <label style={labelStyle}>{t('assistant.types.prompt')}</label>
        <textarea
          value={prompt}
          rows={6}
          onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
          placeholder={t('assistant.types.promptPlaceholder')}
          style={{ ...fieldStyle, resize: 'vertical', lineHeight: 1.5, minHeight: 120 }}
        />
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <Btn kind="ghost" size="md" onClick={onDone} style={{ flex: 1 }}>{t('common.cancel')}</Btn>
        <Btn kind="primary" size="md" onClick={save} style={{ flex: 2 }}>{type ? t('assistant.types.save') : t('assistant.types.create')}</Btn>
      </div>
    </div>
  );
}

export function InterviewTypesSheet({ desk, onClose }: { desk: boolean; onClose: () => void }): VNode {
  const { interviewTypes, deleteInterviewType } = useAppData();
  const [view, setView] = useState<'list' | 'new' | InterviewType>('list');
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const alive = interviewTypes.filter((it) => !it.deleted);

  const newButton = <NewRecordButton label={t('assistant.types.new')} onClick={() => { setArmedDelete(null); setView('new'); }} />;

  const row = (it: InterviewType): VNode => {
    const armed = armedDelete === it.id;
    return (
      <div key={it.id} style={{ border: '1px solid var(--line)', borderRadius: 14, background: 'var(--paper)', padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontFamily: 'var(--serif)', fontSize: 15.5, fontWeight: 500, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name || t('common.untitled')}</span>
            {it.builtin && <BuiltinChip labelKey="assistant.types.builtin" />}
          </div>
          {it.intro && <div style={{ ...UI_13, fontSize: 12, color: 'var(--ink-3)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.intro}</div>}
        </div>
        {armed ? (
          <button onClick={stopRow(() => { deleteInterviewType(it.id); setArmedDelete(null); })} style={{ ...UI_13, fontWeight: 600, color: '#fff', background: 'var(--accent)', border: 'none', borderRadius: 8, padding: '6px 11px', cursor: 'pointer', flexShrink: 0 }}>
            {t('assistant.types.deleteConfirm')}
          </button>
        ) : (
          <>
            <button title={t('common.edit')} aria-label={t('common.edit')} onClick={stopRow(() => { setArmedDelete(null); setView(it); })} style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
              <Icon name="feather" size={15} color="var(--ink-2)" />
            </button>
            <button title={t('common.delete')} aria-label={t('common.delete')} onClick={stopRow(() => setArmedDelete(it.id))} style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
              <Icon name="x" size={15} color="var(--ink-2)" />
            </button>
          </>
        )}
      </div>
    );
  };

  const listBody = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div style={{ maxHeight: desk ? '54vh' : '62vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 9, overscrollBehavior: 'contain' }}>
        {alive.length === 0 ? (
          <div style={{ ...UI_13, color: 'var(--ink-3)', textAlign: 'center', padding: '22px 0' }}>{t('assistant.types.empty')}</div>
        ) : (
          alive.map(row)
        )}
      </div>
      {newButton}
    </div>
  );

  return (
    <Sheet
      desk={desk}
      onClose={onClose}
      zIndex={Z.overlay}
      width={560}
      // Any click that bubbles to the sheet disarms a pending delete.
      onCardClick={() => setArmedDelete(null)}
      cardStyle={{ padding: managerPadding(desk) }}
      title={view === 'list' ? t('assistant.types.title') : view === 'new' ? t('assistant.types.new') : t('assistant.types.edit')}
      accessory={view !== 'list' && <BackToListAccessory label={t('assistant.types.allTypes')} title={t('assistant.types.backToList')} onClick={() => setView('list')} />}
    >
      {view === 'list' ? listBody : <EditorView key={view === 'new' ? 'new' : view.id} type={view === 'new' ? null : view} onDone={() => setView('list')} />}
    </Sheet>
  );
}
