// The one way into a new entry, on every form factor.
//
// It replaces four surfaces that modelled the same choice four ways: the
// desktop sidebar button (which silently created a blank entry in whatever
// notebook came first), the mobile compose chooser's accordion carousels, and
// the long "pick a type" list that opened inside each of the two interview
// sheets. Those pick phases are gone — both sheets are now handed a type, a
// notebook, and the deeper-questions answer, and start straight away.
//
// Two steps, one grid idiom:
//   1. HOW to begin — blank page / template / chat interview / video interview
//   2. WHICH one — a card grid of templates or interview types (last used first)
// Blank commits on the first step; everything else commits by picking a card.
//
// The notebook is never guessed silently. The footer chip always names the
// notebook the entry will land in — resolved from context, else the last one
// used here, else the first — and opens the ordinary JournalSheet on tap. That
// is the fix for "New entry" writing into an arbitrary journal: the guess is
// still made, but it is shown and it is one tap from being changed.
//
// "Last used" ids and the resolved notebook are device-local UI state
// (localStorage, like theme/language) — never synced, never content.
import type { JSX, VNode } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Icon, type IconName } from './Icon';
import { Sheet, SheetGrabber, Z } from './Sheet';
import { JournalSheet } from './JournalPicker';
import { ProviderBadge } from './ProviderBadge';
import { t } from '../i18n';
import { useAppData } from '../state/data';
import type { InterviewType, TemplateRecord } from '../sync/engine';
import type { AiProvider } from '../ai/types';
import { makeProvider } from '../ai/provider';
import { deepReflectionChoice, deepReflectionEnabled, setDeepReflection } from '../ai/reflection';

const LAST_INTERVIEW = 'mneme.compose.lastInterview';
const LAST_TEMPLATE = 'mneme.compose.lastTemplate';
const LAST_JOURNAL = 'mneme.compose.lastJournal';

function readLast(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLast(key: string, id: string): void {
  try {
    localStorage.setItem(key, id);
  } catch {
    /* private mode etc. — ordering is a convenience only */
  }
}

function lastFirst<T extends { id: string }>(items: T[], lastId: string | null): T[] {
  if (!lastId) return items;
  const i = items.findIndex((x) => x.id === lastId);
  if (i <= 0) return items;
  return [items[i], ...items.slice(0, i), ...items.slice(i + 1)];
}

const clamp = (lines: number): JSX.CSSProperties => ({
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: lines,
  overflow: 'hidden',
});

/** What the wizard resolved to — app.tsx turns this into an entry or a sheet. */
export type NewEntryStart =
  | { mode: 'blank'; journalId: string }
  | { mode: 'template'; journalId: string; template: TemplateRecord }
  | { mode: 'interview'; journalId: string; start: InterviewType | 'freeform'; deep: boolean }
  | { mode: 'video'; journalId: string; start: InterviewType; deep: boolean };

type Mode = NewEntryStart['mode'];
type Step = 'mode' | 'pick';

// ── the deeper-questions control ────────────────────────────
// This used to be a blocking one-time overlay (ui/ReflectionConsent.tsx) shown
// before the first AI interview on a device. It sits here instead, above the
// grid it applies to: visible before every interview rather than once ever, and
// changeable on the spot. The disclosure is not dropped in the move — it is
// shown expanded until the question has been answered once, and whenever the
// switch is on, because that is when text actually leaves E2EE. Which line is
// shown follows the LIVE provider, exactly like ProviderBadge: under a local
// backend nothing leaves the device, and saying otherwise would be as wrong as
// hiding it under a cloud one.
//
// Exported standalone (no app context) so scripts/video-interview-repro.ts can
// render it and assert the per-backend copy.
function Bullet({ icon, title, body }: { icon: IconName; title: string; body: string }): VNode {
  return (
    <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
      <span style={{ width: 22, height: 22, borderRadius: 999, flexShrink: 0, marginTop: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent-soft)' }}>
        <Icon name={icon} size={12} color="var(--accent-ink)" />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--ink)' }}>{title}</div>
        <div style={{ fontFamily: 'var(--ui)', fontSize: 12, lineHeight: 1.45, color: 'var(--ink-2)', marginTop: 1 }}>{body}</div>
      </div>
    </div>
  );
}

export function DeepQuestions({ provider, value, onChange }: {
  provider: AiProvider;
  value: boolean;
  onChange: (on: boolean) => void;
}): VNode {
  // null = never answered. The explanation opens itself in that case, so the
  // first interview still meets the full disclosure the overlay used to give.
  const [asked, setAsked] = useState(() => deepReflectionChoice() !== null);
  const expanded = !asked || value;
  const set = (on: boolean): void => {
    setDeepReflection(on);
    setAsked(true);
    onChange(on);
  };
  return (
    <div style={{ borderRadius: 13, border: `1px solid ${value ? 'var(--accent-line)' : 'var(--line)'}`, background: 'var(--paper)', padding: '11px 13px', marginBottom: 12 }}>
      <button
        onClick={() => set(!value)}
        role="switch"
        aria-checked={value}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'start', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
      >
        <span style={{ flex: 1, minWidth: 0, fontFamily: 'var(--ui)', fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>
          {t('assistant.reflect.title')}
        </span>
        <span style={{ width: 36, height: 21, borderRadius: 99, flexShrink: 0, background: value ? 'var(--accent)' : 'var(--line)', position: 'relative', transition: 'background .15s' }}>
          <span style={{ position: 'absolute', top: 2, insetInlineStart: value ? 17 : 2, width: 17, height: 17, borderRadius: 99, background: 'var(--surface)', transition: 'inset-inline-start .15s' }} />
        </span>
      </button>

      {!expanded && (
        <p style={{ fontFamily: 'var(--ui)', fontSize: 12, lineHeight: 1.5, color: 'var(--ink-3)', margin: '6px 0 0' }}>
          {t('prefs.interviews.deepHint')}
        </p>
      )}

      {expanded && (
        <>
          <p style={{ fontFamily: 'var(--ui)', fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-2)', margin: '8px 0 0' }}>
            {t('assistant.reflect.intro')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
            <Bullet icon="clock" title={t('assistant.reflect.gapTitle')} body={t('assistant.reflect.gapBody')} />
            <Bullet icon="feather" title={t('assistant.reflect.olderTitle')} body={t('assistant.reflect.olderBody')} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, margin: '10px 0 5px' }}>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--ink-3)' }}>
              {t('assistant.reflect.dataLabel')}
            </span>
            <ProviderBadge provider={provider} />
          </div>
          <p style={{ fontFamily: 'var(--ui)', fontSize: 12, lineHeight: 1.5, color: 'var(--ink-2)', margin: 0 }}>
            {t('assistant.reflect.dataOnDevice')}
          </p>
          <p style={{ fontFamily: 'var(--ui)', fontSize: 12, lineHeight: 1.5, color: provider.local ? 'var(--ink-2)' : 'var(--accent-ink)', margin: '5px 0 0' }}>
            {provider.local ? t('assistant.reflect.dataLocal') : t('assistant.reflect.dataCloud')}
          </p>
        </>
      )}
    </div>
  );
}

// ── grid pieces ─────────────────────────────────────────────

/** A step-1 tile: how to begin. `muted` is the assistant-is-off state — the
    tile stays visible and explains itself instead of disappearing, which is
    what made the interviews undiscoverable before. */
function ModeTile({ icon, title, hint, muted, onPick }: {
  icon: IconName;
  title: string;
  hint: string;
  muted?: boolean;
  onPick: () => void;
}): VNode {
  return (
    <button
      onClick={onPick}
      style={{ boxSizing: 'border-box', minHeight: 108, textAlign: 'start', cursor: 'pointer', padding: '13px 14px', borderRadius: 14, background: 'var(--paper)', border: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 7, opacity: muted ? 0.62 : 1, transition: 'border-color .14s, opacity .14s' }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent-line)'; e.currentTarget.style.opacity = '1'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--line)'; e.currentTarget.style.opacity = muted ? '0.62' : '1'; }}
    >
      <span style={{ width: 34, height: 34, borderRadius: 10, flexShrink: 0, background: 'var(--accent-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={muted ? 'lock' : icon} size={17} color="var(--accent-ink)" />
      </span>
      <span style={{ display: 'block', fontFamily: 'var(--serif)', fontSize: 15.5, fontWeight: 500, lineHeight: 1.25, color: 'var(--ink)' }}>{title}</span>
      <span style={{ display: 'block', fontFamily: 'var(--ui)', fontSize: 12, lineHeight: 1.4, color: 'var(--ink-3)', ...clamp(2) }}>{hint}</span>
    </button>
  );
}

/** A step-2 card: one template or interview type. `ghost` is the trailing
    "manage…" card, `dashed` the freeform brief. */
function PickCard({ name, snippet, dashed, ghost, onPick }: {
  name: string;
  snippet?: string;
  dashed?: boolean;
  ghost?: boolean;
  onPick: () => void;
}): VNode {
  return (
    <button
      onClick={onPick}
      style={{ boxSizing: 'border-box', minHeight: ghost ? 0 : 92, textAlign: 'start', cursor: 'pointer', padding: '11px 12px', borderRadius: 13, background: dashed || ghost ? 'var(--surface-2)' : 'var(--paper)', border: dashed || ghost ? '1px dashed var(--line)' : '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 4, transition: 'border-color .14s' }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent-line)')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--line)')}
    >
      <span style={{ fontFamily: ghost ? 'var(--ui)' : 'var(--serif)', fontSize: ghost ? 13 : 14.5, fontWeight: ghost ? 600 : 500, lineHeight: 1.3, color: ghost ? 'var(--accent-ink)' : 'var(--ink)', ...clamp(2) }}>{name}</span>
      {snippet && <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, lineHeight: 1.45, color: 'var(--ink-3)', ...clamp(3) }}>{snippet}</span>}
    </button>
  );
}

// ── the wizard ──────────────────────────────────────────────

export function NewEntryWizard({
  desk,
  journalId,
  onClose,
  onStart,
  onManageTypes,
  onManageTemplates,
  onAiSettings,
}: {
  desk: boolean;
  /** Notebook in context (the open notebook / the open entry's notebook). */
  journalId?: string;
  onClose: () => void;
  /** The resolved choice. The wizard closes itself first. */
  onStart: (start: NewEntryStart) => void;
  onManageTypes: () => void;
  onManageTemplates: () => void;
  /** Opens AI settings from a muted interview tile. */
  onAiSettings: () => void;
}): VNode | null {
  const { journals, templates, interviewTypes, aiSettings } = useAppData();
  const [step, setStep] = useState<Step>('mode');
  const [mode, setMode] = useState<Mode>('blank');
  const [pickJournal, setPickJournal] = useState(false);
  const [deep, setDeep] = useState(deepReflectionEnabled);

  // Context first, then the notebook last used from here, then the first one.
  // Resolved once: re-resolving on every render would fight the picker.
  const [target, setTarget] = useState<string>(() => {
    const last = readLast(LAST_JOURNAL);
    const known = (id: string | null | undefined): string | undefined =>
      id && journals.some((j) => j.id === id) ? id : undefined;
    return known(journalId) ?? known(last) ?? journals[0]?.id ?? '';
  });

  const provider = useMemo(() => (aiSettings?.enabled ? makeProvider(aiSettings) : null), [aiSettings]);
  const aliveTypes = useMemo(
    () => lastFirst(interviewTypes.filter((it) => !it.deleted), readLast(LAST_INTERVIEW)),
    [interviewTypes],
  );
  const aliveTemplates = useMemo(
    () => lastFirst(templates.filter((tpl) => !tpl.deleted), readLast(LAST_TEMPLATE)),
    [templates],
  );

  // Escape steps back before it closes — the same shape as the header chevron.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (pickJournal) return; // JournalSheet handles its own Escape.
      if (step === 'pick') setStep('mode');
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, pickJournal, onClose]);

  const start = (s: NewEntryStart): void => {
    if (s.journalId) writeLast(LAST_JOURNAL, s.journalId);
    onClose();
    onStart(s);
  };

  const pickMode = (m: Mode): void => {
    if (m === 'blank') {
      start({ mode: 'blank', journalId: target });
      return;
    }
    if ((m === 'interview' || m === 'video') && !provider) {
      onClose();
      onAiSettings();
      return;
    }
    setMode(m);
    setStep('pick');
  };

  const startInterview = (type: InterviewType | 'freeform'): void => {
    writeLast(LAST_INTERVIEW, type === 'freeform' ? 'freeform' : type.id);
    start({ mode: 'interview', journalId: target, start: type, deep });
  };

  const startVideo = (type: InterviewType): void => {
    writeLast(LAST_INTERVIEW, type.id);
    start({ mode: 'video', journalId: target, start: type, deep });
  };

  const startTemplate = (tpl: TemplateRecord): void => {
    writeLast(LAST_TEMPLATE, tpl.id);
    start({ mode: 'template', journalId: target, template: tpl });
  };

  const grid = (children: VNode[]): VNode => (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${desk ? 3 : 2}, minmax(0, 1fr))`, gap: 9 }}>
      {children}
    </div>
  );

  const modeBody = (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 9 }}>
      <ModeTile icon="feather" title={t('shell.compose.blank')} hint={t('shell.compose.blankHint')} onPick={() => pickMode('blank')} />
      <ModeTile icon="copy" title={t('shell.compose.template')} hint={t('shell.compose.templateHint')} onPick={() => pickMode('template')} />
      <ModeTile
        icon="mic"
        title={t('shell.compose.interview')}
        hint={provider ? t('shell.compose.interviewHint') : t('shell.compose.aiOff')}
        muted={!provider}
        onPick={() => pickMode('interview')}
      />
      <ModeTile
        icon="film"
        title={t('shell.compose.videoInterview')}
        hint={provider ? t('shell.compose.videoInterviewHint') : t('shell.compose.aiOff')}
        muted={!provider}
        onPick={() => pickMode('video')}
      />
    </div>
  );

  const emptyNote = (text: string): VNode => (
    <p style={{ fontFamily: 'var(--ui)', fontSize: 13, lineHeight: 1.5, color: 'var(--ink-3)', textAlign: 'center', margin: '10px 0 14px' }}>{text}</p>
  );

  const templateBody = (
    <>
      {aliveTemplates.length === 0 && emptyNote(t('templates.empty'))}
      {grid([
        ...aliveTemplates.map((tpl) => (
          <PickCard key={tpl.id} name={tpl.name || t('templates.untitled')} snippet={tpl.bodyText.replace(/\n+/g, ' · ')} onPick={() => startTemplate(tpl)} />
        )),
        <PickCard key="manage" ghost name={t('shell.compose.manageTemplates')} onPick={() => { onClose(); onManageTemplates(); }} />,
      ])}
    </>
  );

  // Video takes the same types but no freeform card: a session records against a
  // planned question list, and a freeform brief has none.
  const interviewBody = (video: boolean): VNode => (
    <>
      {provider && <DeepQuestions provider={provider} value={deep} onChange={setDeep} />}
      {aliveTypes.length === 0 && emptyNote(t('shell.compose.noTypes'))}
      {grid([
        ...aliveTypes.map((it) => (
          <PickCard
            key={it.id}
            name={it.name || t('common.untitled')}
            snippet={it.intro}
            onPick={() => (video ? startVideo(it) : startInterview(it))}
          />
        )),
        ...(video
          ? []
          : [<PickCard key="freeform" dashed name={t('assistant.interview.freeform')} snippet={t('assistant.interview.freeformHint')} onPick={() => startInterview('freeform')} />]),
        <PickCard key="manage" ghost name={t('assistant.interview.manageTypes')} onPick={() => { onClose(); onManageTypes(); }} />,
      ])}
    </>
  );

  const title =
    step === 'mode' ? t('shell.newEntry')
    : mode === 'template' ? t('shell.compose.pickTemplate')
    : mode === 'video' ? t('shell.compose.videoInterview')
    : t('shell.compose.interview');

  const journalObj = journals.find((j) => j.id === target);

  const padX = desk ? 22 : 18;

  return (
    <>
      <Sheet
        desk={desk}
        onClose={onClose}
        zIndex={Z.overlay}
        width={580}
        grabber={false}
        role="dialog"
        cardStyle={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', maxHeight: desk ? '86vh' : '88vh' }}
      >
        {!desk && <SheetGrabber style={{ margin: '10px auto 2px' }} />}

        {/* Header: the back chevron is the only way the two steps differ. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: `${desk ? 18 : 10}px ${padX}px 12px`, borderBottom: '1px solid var(--line)' }}>
          {step === 'pick' && (
            <button
              onClick={() => setStep('mode')}
              aria-label={t('common.back')}
              title={t('common.back')}
              style={{ width: 30, height: 30, borderRadius: 9, flexShrink: 0, border: '1px solid var(--line)', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
            >
              <Icon name="left" size={15} color="var(--ink-2)" dirFlip />
            </button>
          )}
          <h3 style={{ flex: 1, minWidth: 0, fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, color: 'var(--ink)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {title}
          </h3>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            style={{ width: 30, height: 30, borderRadius: 9, flexShrink: 0, border: '1px solid var(--line)', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          >
            <Icon name="x" size={15} color="var(--ink-2)" />
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: `14px ${padX}px 16px` }}>
          {step === 'mode' ? modeBody : mode === 'template' ? templateBody : interviewBody(mode === 'video')}
        </div>

        {/* Where it lands. Always named, always one tap from changing — the
            wizard never files an entry into a notebook it did not show. */}
        {journalObj && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, borderTop: '1px solid var(--line)', background: 'var(--surface-2)', padding: `10px ${padX}px calc(env(safe-area-inset-bottom, 0px) + ${desk ? 10 : 16}px)` }}>
            <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--ink-3)', flexShrink: 0 }}>
              {t('shell.compose.notebook')}
            </span>
            <button
              onClick={() => setPickJournal(true)}
              disabled={journals.length < 2}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0, background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 10, padding: '6px 10px', cursor: journals.length < 2 ? 'default' : 'pointer', color: 'var(--ink)', fontFamily: 'var(--ui)', fontSize: 13, fontWeight: 600 }}
            >
              <span style={{ width: 9, height: 9, borderRadius: 3, flexShrink: 0, background: journalObj.color }} />
              <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{journalObj.name}</span>
              {journals.length > 1 && <Icon name="down" size={12} color="var(--ink-3)" />}
            </button>
          </div>
        )}
      </Sheet>

      {pickJournal && (
        <JournalSheet
          journals={journals}
          currentId={target}
          desk={desk}
          onClose={() => setPickJournal(false)}
          onPick={(id) => { setTarget(id); setPickJournal(false); }}
        />
      )}
    </>
  );
}
