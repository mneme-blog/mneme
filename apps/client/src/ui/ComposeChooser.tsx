// Mobile compose chooser — the feather FAB opens this sheet instead of
// silently creating a blank entry. Three ways to begin: an empty entry, an AI
// interview (only when the assistant is enabled), or a template. Interview and
// template expand in place into a horizontal card carousel, so the sheet stays
// compact; the most recently used card is pinned first so the habitual pick is
// always one tap away. Those "last used" ids are device-local UI state
// (localStorage, like theme/language) — never synced, never content.
import type { JSX, VNode } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { Icon, type IconName } from './Icon';
import { t } from '../i18n';
import { useAppData } from '../state/data';
import type { InterviewType, TemplateRecord } from '../sync/engine';

const LAST_INTERVIEW = 'mneme.compose.lastInterview';
const LAST_TEMPLATE = 'mneme.compose.lastTemplate';
// Pseudo-id for the freeform-brief card in the interview carousel.
const FREEFORM = 'freeform';

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

// One card in a carousel — name plus an optional muted snippet, line-clamped
// so every card keeps the same footprint.
function Card({ name, snippet, dashed, onPick }: { name: string; snippet?: string; dashed?: boolean; onPick: () => void }): VNode {
  return (
    <button
      onClick={onPick}
      style={{ flexShrink: 0, width: 150, boxSizing: 'border-box', scrollSnapAlign: 'start', textAlign: 'start', cursor: 'pointer', padding: '11px 12px', borderRadius: 12, background: dashed ? 'var(--surface-2)' : 'var(--paper)', border: dashed ? '1px dashed var(--line)' : '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 4 }}
    >
      <span style={{ fontFamily: 'var(--serif)', fontSize: 14.5, fontWeight: 500, lineHeight: 1.3, color: 'var(--ink)', ...clamp(2) }}>{name}</span>
      {snippet && <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, lineHeight: 1.45, color: 'var(--ink-3)', ...clamp(3) }}>{snippet}</span>}
    </button>
  );
}

type Section = 'interview' | 'video' | 'template';

export function ComposeChooser({
  onClose,
  onEmpty,
  onInterview,
  onVideoInterview,
  onTemplate,
}: {
  onClose: () => void;
  /** Create a blank entry (in the active notebook, like the FAB used to). */
  onEmpty: () => void;
  /** Start a guided interview with the picked type (or the freeform brief). Null while the AI assistant is disabled — the row hides itself. */
  onInterview: ((start: InterviewType | 'freeform') => void) | null;
  /** Answer the picked type on camera instead. Null while the AI assistant is disabled. */
  onVideoInterview: ((start: InterviewType) => void) | null;
  /** Start a new entry pre-filled from the picked template. */
  onTemplate: (tpl: TemplateRecord) => void;
}): VNode {
  const { templates, interviewTypes } = useAppData();
  // Which carousel is open — expanding one collapses the other.
  const [open, setOpen] = useState<Section | null>(null);

  // Interview cards: live types plus the freeform brief, last-used first.
  const interviewCards = useMemo(() => {
    const cards: { id: string; type: InterviewType | null }[] = [
      ...interviewTypes.filter((it) => !it.deleted).map((it) => ({ id: it.id, type: it as InterviewType | null })),
      { id: FREEFORM, type: null },
    ];
    return lastFirst(cards, readLast(LAST_INTERVIEW));
  }, [interviewTypes]);

  const templateCards = useMemo(
    () => lastFirst(templates.filter((tpl) => !tpl.deleted), readLast(LAST_TEMPLATE)),
    [templates],
  );

  const carousel = (cards: VNode[]): VNode => (
    <div style={{ display: 'flex', gap: 9, overflowX: 'auto', padding: '12px 14px 14px', scrollSnapType: 'x proximity', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', borderTop: '1px solid var(--line)' }}>
      {cards}
    </div>
  );

  // A section container: header row, plus (when expandable) the carousel below.
  const section = (icon: IconName, title: string, hint: string, opts: { section?: Section; onPick?: () => void; body?: VNode }): VNode => {
    const expanded = opts.section != null && open === opts.section;
    return (
      <div style={{ border: `1px solid ${expanded ? 'var(--accent)' : 'var(--line)'}`, borderRadius: 14, background: 'var(--paper)', overflow: 'hidden' }}>
        <button
          onClick={opts.onPick ?? (() => setOpen(expanded ? null : opts.section!))}
          aria-expanded={opts.section != null ? expanded : undefined}
          style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'start', cursor: 'pointer', padding: '13px 14px', background: 'transparent', border: 'none' }}
        >
          <span style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--accent-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon name={icon} size={18} color="var(--accent-ink)" />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontFamily: 'var(--serif)', fontSize: 15.5, fontWeight: 500, color: 'var(--ink)' }}>{title}</span>
            <span style={{ display: 'block', fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--ink-3)', marginTop: 1 }}>{hint}</span>
          </span>
          <Icon name={expanded ? 'down' : 'right'} size={17} color="var(--ink-3)" dirFlip={!expanded} />
        </button>
        {expanded && opts.body}
      </div>
    );
  };

  const pickInterview = (card: { id: string; type: InterviewType | null }): void => {
    writeLast(LAST_INTERVIEW, card.id);
    onInterview?.(card.type ?? 'freeform');
  };

  const pickTemplate = (tpl: TemplateRecord): void => {
    writeLast(LAST_TEMPLATE, tpl.id);
    onTemplate(tpl);
  };

  const interviewBody = carousel(
    interviewCards.map((card) => (
      <Card
        key={card.id}
        name={card.type ? card.type.name || t('common.untitled') : t('assistant.interview.freeform')}
        snippet={card.type ? card.type.intro : t('assistant.interview.freeformHint')}
        dashed={!card.type}
        onPick={() => pickInterview(card)}
      />
    )),
  );

  // Same types, answered on camera. No freeform card — a video session records
  // against a planned question list, and a freeform brief has none.
  const videoBody = carousel(
    interviewCards
      .filter((card) => card.type)
      .map((card) => (
        <Card
          key={card.id}
          name={card.type?.name || t('common.untitled')}
          snippet={card.type?.intro ?? ''}
          onPick={() => {
            writeLast(LAST_INTERVIEW, card.id);
            if (card.type) onVideoInterview?.(card.type);
          }}
        />
      )),
  );

  const templateBody =
    templateCards.length === 0 ? (
      <div style={{ fontFamily: 'var(--ui)', fontSize: 13, color: 'var(--ink-3)', textAlign: 'center', padding: '16px 14px', borderTop: '1px solid var(--line)' }}>
        {t('templates.empty')}
      </div>
    ) : (
      carousel(
        templateCards.map((tpl) => (
          <Card
            key={tpl.id}
            name={tpl.name || t('templates.untitled')}
            snippet={tpl.bodyText.replace(/\n+/g, ' · ')}
            onPick={() => pickTemplate(tpl)}
          />
        )),
      )
    );

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(30,22,16,.34)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', boxSizing: 'border-box', background: 'var(--surface)', borderRadius: '24px 24px 0 0', border: '1px solid var(--line)', padding: '20px 22px calc(env(safe-area-inset-bottom, 0px) + 30px)', boxShadow: '0 20px 60px rgba(30,20,12,.3)' }}
      >
        <div style={{ width: 38, height: 4, borderRadius: 9, background: 'var(--line)', margin: '0 auto 16px' }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 0 14px' }}>
          <h3 style={{ fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, color: 'var(--ink)', margin: 0 }}>{t('shell.newEntry')}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--ink-3)' }} aria-label={t('common.close')}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {section('feather', t('shell.compose.empty'), t('shell.compose.emptyHint'), { onPick: onEmpty })}
          {onInterview && section('mic', t('shell.compose.interview'), t('shell.compose.interviewHint'), { section: 'interview', body: interviewBody })}
          {onVideoInterview && interviewCards.some((c) => c.type) && section('film', t('shell.compose.videoInterview'), t('shell.compose.videoInterviewHint'), { section: 'video', body: videoBody })}
          {section('copy', t('shell.compose.template'), t('shell.compose.templateHint'), { section: 'template', body: templateBody })}
        </div>
      </div>
    </div>
  );
}
