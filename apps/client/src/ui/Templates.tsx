// Template manager: a sheet listing every entry template (built-in seeds and
// user-created alike — built-ins are ordinary records the user may rewrite or
// delete), with a small rich editor for creating and editing template bodies.
// "Use" hands the template to the caller, which starts a new entry from it.
//
// Layout: on desktop the list view is master/detail — picking a template shows
// a rendered preview (DocPreview, true editor typography) beside the list. On
// mobile each row expands in place to its preview + actions, so the whole flow
// stays inside one bottom sheet with no nested modals.
import type { VNode } from 'preact';
import { useMemo, useRef, useState } from 'preact/hooks';
import { Icon } from './Icon';
import { Btn } from './primitives';
import { Sheet, Z } from './Sheet';
import { BuiltinChip, BackToListAccessory, NewRecordButton, managerPadding, stopRow } from './manager';
import { t } from '../i18n';
import { useAppData } from '../state/data';
import type { TemplateRecord } from '../sync/engine';
import { useRichEditor } from '../editor/useRichEditor';
import { parseBody } from '../editor/doc';
import { DocPreview } from '../editor/DocPreview';
import { createMathHandle, MathDialog } from '../editor/math';
import { buildSlashCommands, createSlashHandle } from '../editor/slash';
import { SlashMenu } from '../editor/SlashMenu';
import { EditorToolbar } from '../editor/Toolbar';
import '../editor/editor.css';

const UI_13 = { fontFamily: 'var(--ui)', fontSize: 13 } as const;

function TemplateEditorView({
  template,
  onDone,
}: {
  template: TemplateRecord | null; // null → creating a new template
  onDone: () => void;
}): VNode {
  const { createTemplate, updateTemplate } = useAppData();
  const [name, setName] = useState(template?.name ?? '');
  const body = useRef<{ json: string; text: string }>({
    json: template?.bodyJson ?? '',
    text: template?.bodyText ?? '',
  });
  const initial = useMemo(() => parseBody(template?.bodyJson, template?.bodyText ?? ''), []);
  const mathHandle = useMemo(createMathHandle, []);
  const slashHandle = useMemo(createSlashHandle, []);
  // Block + math commands only — media, entry links, and template-in-template
  // inserts don't apply to a template body.
  const slashCommands = useMemo(
    () => buildSlashCommands({ onMath: (kind) => mathHandle.listener?.({ kind, latex: '', pos: null }) }),
    [],
  );
  const { editor, mountRef } = useRichEditor({
    initial,
    placeholder: t('templates.body.placeholder'),
    math: mathHandle,
    slash: { handle: slashHandle, commands: slashCommands },
    onChange: (c) => {
      body.current = c;
    },
  });

  const save = (): void => {
    const input = { name: name.trim() || t('templates.untitled'), bodyJson: body.current.json || undefined, bodyText: body.current.text };
    if (template) updateTemplate(template.id, input);
    else createTemplate(input);
    onDone();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <input
          autoFocus={!template}
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          placeholder={t('templates.name.placeholder')}
          style={{ width: '100%', boxSizing: 'border-box', border: 'none', outline: 'none', background: 'transparent', fontFamily: 'var(--serif)', fontSize: 20, color: 'var(--ink)', fontWeight: 500 }}
        />
        <div style={{ height: 1, background: 'var(--line)', marginTop: 4 }} />
      </div>
      <EditorToolbar editor={editor} />
      <div
        ref={mountRef}
        style={{ minHeight: 180, maxHeight: '42vh', overflow: 'auto', padding: '4px 12px', borderRadius: 12, border: '1px solid var(--line)', background: 'var(--paper)' }}
      />
      <SlashMenu handle={slashHandle} />
      <MathDialog handle={mathHandle} editor={editor} />
      <div style={{ display: 'flex', gap: 10 }}>
        <Btn kind="ghost" size="md" onClick={onDone} style={{ flex: 1 }}>{t('common.cancel')}</Btn>
        <Btn kind="primary" size="md" onClick={save} style={{ flex: 2 }}>
          {template ? t('templates.save') : t('templates.create')}
        </Btn>
      </div>
    </div>
  );
}

// Use / edit / delete for one template; `compact` renders the desktop pane
// header sizing, otherwise the mobile full-width action bar.
function TemplateActions({
  compact,
  armed,
  useLabel,
  onUse,
  onEdit,
  onDelete,
}: {
  compact: boolean;
  armed: boolean; // delete was tapped once; the next tap commits
  useLabel: string;
  onUse: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): VNode {
  const side = compact ? 30 : 40;
  const iconBtn = (title: string, name: 'feather' | 'x', onClick: () => void): VNode => (
    <button
      title={title}
      aria-label={title}
      onClick={stopRow(onClick)}
      style={{ width: side, height: side, borderRadius: compact ? 8 : 10, border: '1px solid var(--line)', background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
    >
      <Icon name={name} size={compact ? 15 : 17} color="var(--ink-2)" />
    </button>
  );
  if (armed) {
    return (
      <button
        onClick={stopRow(onDelete)}
        style={{ ...UI_13, fontWeight: 600, color: '#fff', background: 'var(--accent)', border: 'none', borderRadius: compact ? 8 : 10, padding: compact ? '6px 11px' : '11px 0', cursor: 'pointer', flexShrink: 0, flex: compact ? undefined : 1 }}
      >
        {t('templates.deletePermanently')}
      </button>
    );
  }
  return (
    <>
      <button
        onClick={stopRow(onUse)}
        style={{ ...UI_13, fontSize: compact ? 13 : 14, fontWeight: 600, color: 'var(--accent-ink)', background: 'var(--accent-soft)', border: '1px solid var(--accent)', borderRadius: compact ? 8 : 10, padding: compact ? '5px 12px' : '10px 0', cursor: 'pointer', flexShrink: 0, flex: compact ? undefined : 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
      >
        <Icon name="feather" size={compact ? 13 : 15} color="var(--accent-ink)" /> {useLabel}
      </button>
      {iconBtn(t('templates.action.edit'), 'feather', onEdit)}
      {iconBtn(t('templates.action.delete'), 'x', onDelete)}
    </>
  );
}

// Scrollable rendered preview, shared by the desktop pane and mobile accordion.
// flex/minHeight let it fill the desktop pane; `maxHeight` caps the accordion.
function PreviewBody({ tpl, maxHeight }: { tpl: TemplateRecord; maxHeight?: string }): VNode {
  return (
    <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, maxHeight, padding: '14px 18px 18px', overscrollBehavior: 'contain' }}>
      <DocPreview json={tpl.bodyJson} text={tpl.bodyText} />
    </div>
  );
}

export function TemplatesSheet({
  desk,
  useLabel,
  onClose,
  onUse,
}: {
  desk: boolean;
  /** Label of the primary action — "Use" in the manager, "Insert" as the editor's picker. */
  useLabel?: string;
  onClose: () => void;
  onUse: (tpl: TemplateRecord) => void;
}): VNode {
  const { templates, deleteTemplate } = useAppData();
  // 'list' | the template being edited | 'new'
  const [view, setView] = useState<'list' | 'new' | TemplateRecord>('list');
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  // Desktop: which template the preview pane shows (falls back to the first).
  // Mobile: which row is expanded (null → all collapsed).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const alive = templates.filter((tpl) => !tpl.deleted);

  const actionsFor = (tpl: TemplateRecord, compact: boolean): VNode => (
    <TemplateActions
      compact={compact}
      useLabel={useLabel ?? t('templates.use')}
      armed={armedDelete === tpl.id}
      onUse={() => onUse(tpl)}
      onEdit={() => { setArmedDelete(null); setView(tpl); }}
      onDelete={() => {
        if (armedDelete === tpl.id) {
          deleteTemplate(tpl.id);
          setArmedDelete(null);
        } else {
          setArmedDelete(tpl.id);
        }
      }}
    />
  );

  const newButton = <NewRecordButton label={t('templates.new')} onClick={() => { setArmedDelete(null); setView('new'); }} />;

  const empty = (
    <div style={{ ...UI_13, color: 'var(--ink-3)', textAlign: 'center', padding: '22px 0' }}>
      {t('templates.empty')}
    </div>
  );

  // ── desktop list view: selectable rows + preview pane ──
  const deskList = (): VNode => {
    const sel = alive.find((tpl) => tpl.id === selectedId) ?? alive[0];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {alive.length === 0 ? (
          empty
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '218px minmax(0, 1fr)', gap: 12, height: '54vh', minHeight: 320 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', paddingInlineEnd: 2 }}>
              {alive.map((tpl) => {
                const active = tpl.id === sel?.id;
                return (
                  <button
                    key={tpl.id}
                    onClick={stopRow(() => { setArmedDelete(null); setSelectedId(tpl.id); })}
                    style={{ textAlign: 'start', cursor: 'pointer', padding: '11px 12px', borderRadius: 10, background: active ? 'var(--accent-soft)' : 'var(--paper)', border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`, display: 'flex', flexDirection: 'column', gap: 3 }}
                  >
                    <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                      <span style={{ fontFamily: 'var(--serif)', fontSize: 14.5, fontWeight: 500, color: active ? 'var(--accent-ink)' : 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {tpl.name || t('templates.untitled')}
                      </span>
                      {tpl.builtin && <BuiltinChip labelKey="templates.builtin" />}
                    </span>
                  </button>
                );
              })}
            </div>
            {sel && (
              <div style={{ border: '1px solid var(--line)', borderRadius: 14, background: 'var(--paper)', display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBlock: 10, paddingInlineStart: 16, paddingInlineEnd: 12, borderBottom: '1px solid var(--line)', background: 'var(--surface-2)' }}>
                  <span style={{ fontFamily: 'var(--serif)', fontSize: 15.5, fontWeight: 500, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                    {sel.name || t('templates.untitled')}
                    {sel.builtin && <BuiltinChip labelKey="templates.builtin" />}
                  </span>
                  {actionsFor(sel, true)}
                </div>
                <PreviewBody tpl={sel} />
              </div>
            )}
          </div>
        )}
        {newButton}
      </div>
    );
  };

  // ── mobile list view: accordion rows (tap to preview in place) ──
  const mobileList = (): VNode => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div style={{ maxHeight: '62vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 9, overscrollBehavior: 'contain' }}>
        {alive.length === 0 && empty}
        {alive.map((tpl) => {
          const open = tpl.id === selectedId;
          return (
            <div key={tpl.id} style={{ border: `1px solid ${open ? 'var(--accent)' : 'var(--line)'}`, borderRadius: 14, background: 'var(--paper)', overflow: 'hidden' }}>
              <button
                onClick={stopRow(() => { setArmedDelete(null); setSelectedId(open ? null : tpl.id); })}
                aria-expanded={open}
                style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'start', cursor: 'pointer', padding: '13px 14px', background: 'transparent', border: 'none' }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ fontFamily: 'var(--serif)', fontSize: 15.5, fontWeight: 500, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {tpl.name || t('templates.untitled')}
                    </span>
                    {tpl.builtin && <BuiltinChip labelKey="templates.builtin" />}
                  </span>
                  {!open && (
                    <span style={{ ...UI_13, fontSize: 12, color: 'var(--ink-3)', marginTop: 2, display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {tpl.bodyText.replace(/\n+/g, ' · ') || t('templates.emptyBody')}
                    </span>
                  )}
                </span>
                <Icon name={open ? 'down' : 'right'} size={17} color="var(--ink-3)" dirFlip={!open} />
              </button>
              {open && (
                <>
                  <div style={{ borderTop: '1px solid var(--line)' }}>
                    <PreviewBody tpl={tpl} maxHeight="34vh" />
                  </div>
                  <div style={{ display: 'flex', gap: 8, padding: '10px 12px', borderTop: '1px solid var(--line)', background: 'var(--surface-2)' }}>
                    {actionsFor(tpl, false)}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      {newButton}
    </div>
  );

  const body =
    view === 'list' ? (
      desk ? deskList() : mobileList()
    ) : (
      <TemplateEditorView
        key={view === 'new' ? 'new' : view.id}
        template={view === 'new' ? null : view}
        onDone={() => setView('list')}
      />
    );

  return (
    <Sheet
      desk={desk}
      onClose={onClose}
      zIndex={Z.overlay}
      width={view === 'list' ? 720 : 520}
      // The sheet container disarms the delete confirmation on any click that
      // bubbles up to it — row actions stopPropagation so they don't count.
      onCardClick={() => setArmedDelete(null)}
      cardStyle={{ padding: managerPadding(desk), transition: 'width .15s' }}
      title={view === 'list' ? t('templates.title') : view === 'new' ? t('templates.new') : t('templates.editTitle')}
      accessory={view !== 'list' && <BackToListAccessory label={t('templates.all')} title={t('templates.backToList')} onClick={() => setView('list')} />}
    >
      {body}
    </Sheet>
  );
}
