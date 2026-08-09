import type { VNode, ComponentChildren, JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Icon, type IconName } from '../ui/Icon';
import { Btn, LabelChip, ConnChip } from '../ui/primitives';
import { hexA } from '../ui/color';
import { type Journal } from '../data/sample';
import { useAppData } from '../state/data';
import { compactCount, dailyCounts, dayStreak, monthWords, onThisDay } from '../state/stats';
import { EntryThumbs, entryImages } from '../ui/EntryThumbs';
import type { JournalEntry, MediaAttachment } from '../sync/engine';
import { t, tp, fmtDate, fmtNumber, monthName, weekdayName } from '../i18n';

type CalView = 'month' | 'year' | 'timeline';

// Calendar view of a JournalEntry — derived (UTC) so seeded + new entries agree.
interface CalEntry {
  id: string;
  journal: string;
  time: string;
  title: string;
  preview: string;
  labels: string[];
}

function toCalEntry(e: JournalEntry): CalEntry {
  const d = new Date(e.createdAt);
  return {
    id: e.id,
    journal: e.journalId,
    time: fmtDate(d, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }),
    title: e.title,
    preview: e.bodyText,
    labels: e.labels,
  };
}

function monthMeta(year: number, month: number): { offset: number; days: number } {
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay(); // 0=Sun
  const offset = (first + 6) % 7; // Mon-first
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return { offset, days };
}

// Timeline list date: always carries the year so cross-year scrolling stays clear.
function timelineDate(d: Date): string {
  return fmtDate(d, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function EntryRow({ e, onOpen, compact, resolve }: { e: CalEntry; onOpen: (id: string) => void; compact?: boolean; resolve: (id: string) => Journal | undefined }): VNode {
  const j = resolve(e.journal);
  const color = j?.color ?? 'var(--ink-3)';
  return (
    <button
      onClick={() => onOpen(e.id)}
      style={{ display: 'flex', gap: 12, width: '100%', textAlign: 'start', cursor: 'pointer', padding: compact ? '10px 12px' : '13px 14px', borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--line)', transition: 'all .14s', alignItems: 'flex-start' }}
      onMouseEnter={(ev) => (ev.currentTarget.style.borderColor = hexA(j?.color ?? '#999999', 0.5))}
      onMouseLeave={(ev) => (ev.currentTarget.style.borderColor = 'var(--line)')}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, paddingTop: 2, minWidth: 42 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)', fontWeight: 500 }}>{e.time}</span>
        <span style={{ width: 7, height: 7, borderRadius: 9, background: color }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontFamily: 'var(--serif)', fontSize: 16, fontWeight: 500, color: 'var(--ink)' }}>{e.title}</span>
        <p style={{ fontFamily: 'var(--ui)', fontSize: 13, color: 'var(--ink-2)', margin: '3px 0 0', lineHeight: 1.5, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{e.preview}</p>
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--ink-3)' }}>{j?.name}</span>
          {e.labels.map((l) => <LabelChip key={l} id={l} size="sm" />)}
        </div>
      </div>
    </button>
  );
}

function Heatmap({ counts }: { counts: number[] }): VNode {
  const cells = counts.map((n) => Math.min(n, 3));
  const col = ['var(--line)', 'var(--accent-soft)', hexA('#B0563A', 0.45), 'var(--accent)'];
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateRows: 'repeat(7, 1fr)', gridAutoFlow: 'column', gridAutoColumns: '1fr', gap: 3 }}>
        {cells.map((l, i) => <div key={i} style={{ aspectRatio: '1', borderRadius: 3, background: l === 0 ? col[0] : col[l] }} />)}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
        <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-3)' }}>{tp('calendar.weeks', counts.length / 7)}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-3)' }}>{t('calendar.heatLess')}</span>
          {col.map((c, i) => <span key={i} style={{ width: 9, height: 9, borderRadius: 2.5, background: c }} />)}
          <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-3)' }}>{t('calendar.heatMore')}</span>
        </div>
      </div>
    </div>
  );
}

function Cell({ d, today, selected, onSelect, big, dayEntries, resolve }: { d: number; today: number; selected: number; onSelect: (d: number) => void; big?: boolean; dayEntries: CalEntry[]; resolve: (id: string) => Journal | undefined }): VNode {
  const entries = dayEntries;
  const isToday = d === today;
  const isSel = d === selected;
  return (
    <button
      onClick={() => onSelect(d)}
      style={{
        position: 'relative', borderRadius: big ? 12 : 999, minWidth: 0, overflow: 'hidden',
        ...(big ? { minHeight: 0 } : { aspectRatio: '1' }),
        display: 'flex', flexDirection: 'column', alignItems: big ? 'stretch' : 'center', justifyContent: big ? 'flex-start' : 'center',
        cursor: 'pointer', padding: big ? '7px 8px' : 0,
        background: isSel ? 'var(--accent)' : big && entries.length ? 'var(--surface)' : 'transparent',
        border: big ? `1px solid ${isSel ? 'var(--accent)' : 'var(--line)'}` : isToday && !isSel ? '1.5px solid var(--accent)' : '1.5px solid transparent',
        transition: 'all .12s',
      }}
    >
      <span style={{ fontFamily: 'var(--ui)', fontSize: big ? 13 : 14, fontWeight: isToday || isSel ? 700 : 500, color: isSel ? '#fff' : isToday ? 'var(--accent-ink)' : 'var(--ink)', alignSelf: big ? 'flex-start' : 'center' }}>{d}</span>

      {big ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 5, overflow: 'hidden' }}>
          {entries.slice(0, 3).map((e) => {
            const j = resolve(e.journal);
            return (
              <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                <span style={{ width: 6, height: 6, borderRadius: 9, background: isSel ? '#fff' : j?.color, flexShrink: 0 }} />
                <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: isSel ? 'rgba(255,255,255,.9)' : 'var(--ink-2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.title}</span>
              </div>
            );
          })}
          {entries.length > 3 && <span style={{ fontFamily: 'var(--ui)', fontSize: 10.5, color: isSel ? 'rgba(255,255,255,.85)' : 'var(--ink-3)' }}>{tp('calendar.more', entries.length - 3)}</span>}
        </div>
      ) : (
        entries.length > 0 && (
          <div style={{ display: 'flex', gap: 3, marginTop: 4, position: 'absolute', bottom: 6 }}>
            {entries.slice(0, 3).map((e) => {
              const j = resolve(e.journal);
              return <span key={e.id} style={{ width: 5, height: 5, borderRadius: 9, background: isSel ? '#fff' : j?.color }} />;
            })}
          </div>
        )
      )}
    </button>
  );
}

export function CalendarScreen({ desk, onOpenEntry }: { desk: boolean; onOpenEntry: (id: string) => void }): VNode {
  const { entries, journals, mediaThumb } = useAppData();
  // Resolve against the live notebooks (user-created and imported ones aren't in
  // the static seed) so calendar dots and rows carry the right journal colour.
  const resolveJournal = useMemo(() => {
    const byId = new Map(journals.map((j) => [j.id, j]));
    return (id: string): Journal | undefined => byId.get(id);
  }, [journals]);

  const now = new Date();
  const todayY = now.getUTCFullYear();
  const todayM = now.getUTCMonth();
  const todayD = now.getUTCDate();

  const [view, setView] = useState<CalView>('year');
  const [year, setYear] = useState(todayY);
  const [month, setMonth] = useState(todayM);
  const [selected, setSelected] = useState(todayD);

  const isCurrentMonth = year === todayY && month === todayM;
  const meta = monthMeta(year, month);
  const today = isCurrentMonth ? todayD : -1;

  // ── navigation ──
  const shiftMonth = (delta: number) => {
    const abs = year * 12 + month + delta;
    setYear(Math.floor(abs / 12));
    setMonth(((abs % 12) + 12) % 12);
  };
  const goToday = () => { setYear(todayY); setMonth(todayM); setSelected(todayD); };
  const openMonth = (m: number, day = 1) => { setMonth(m); setSelected(day); setView('month'); };
  // Prev/next steps by month in the month view, by year in the year view.
  const stepView = (delta: number) => (view === 'year' ? setYear((y) => y + delta) : shiftMonth(delta));

  // Group the visible month's entries by day-of-month.
  const byDay = useMemo(() => {
    const map = new Map<number, CalEntry[]>();
    for (const e of entries) {
      const d = new Date(e.createdAt);
      if (d.getUTCFullYear() === year && d.getUTCMonth() === month) {
        const day = d.getUTCDate();
        (map.get(day) ?? map.set(day, []).get(day)!).push(toCalEntry(e));
      }
    }
    return map;
  }, [entries, year, month]);
  const monthCount = useMemo(() => [...byDay.values()].reduce((n, list) => n + list.length, 0), [byDay]);
  const dayEntries = byDay.get(selected) ?? [];

  // Per-month + per-day buckets for the year overview.
  const yearData = useMemo(() => {
    const months = Array.from({ length: 12 }, () => ({ count: 0, days: new Map<number, number>() }));
    for (const e of entries) {
      const d = new Date(e.createdAt);
      if (d.getUTCFullYear() === year) {
        const m = d.getUTCMonth();
        const day = d.getUTCDate();
        months[m].count += 1;
        months[m].days.set(day, (months[m].days.get(day) ?? 0) + 1);
      }
    }
    return months;
  }, [entries, year]);
  const yearTotal = useMemo(() => yearData.reduce((n, m) => n + m.count, 0), [yearData]);
  const yearDays = useMemo(() => yearData.reduce((n, m) => n + m.days.size, 0), [yearData]);
  const busiestMonth = useMemo(() => {
    let best = -1, bestN = 0;
    yearData.forEach((m, i) => { if (m.count > bestN) { bestN = m.count; best = i; } });
    return best;
  }, [yearData]);

  // Newest-first across every notebook — the global timeline.
  const timeline = useMemo(() => [...entries].sort((a, b) => b.createdAt - a.createdAt), [entries]);

  const streak = useMemo(() => dayStreak(entries, Date.now()), [entries]);
  const words = useMemo(() => monthWords(entries, year, month), [entries, year, month]);
  const memories = useMemo(() => onThisDay(entries, month, selected, year), [entries, month, selected, year]);
  const heat = useMemo(() => dailyCounts(entries, Date.now(), 17), [entries]);

  // The four view blocks are module-level components (CalGrid/CalNav/CalTabs/
  // CalYearOverview): defined inline here they'd get a fresh function identity
  // every render, and Preact remounts on a changed component type — every day
  // cell rebuilt per click, and the YearJump popover snapping shut on any state
  // change. Bind their props once per render instead.
  const navProps = { view, year, month, isCurrentMonth, todayY, timelineCount: timeline.length, onStep: stepView, onGoToday: goToday, onPickYear: setYear };
  const gridProps = { meta, today, selected, onSelect: setSelected, byDay, resolve: resolveJournal };
  const yearProps = { year, yearData, todayY, todayM, onOpenMonth: openMonth };

  if (desk) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--paper)' }}>
        <div style={{ padding: '24px 28px 16px', borderBottom: '1px solid var(--line)' }}>
          <div style={{ marginBottom: 16 }}><CalNav big {...navProps} /></div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            {view === 'year' ? (
              <>
                <Stat n={fmtNumber(streak)} label={t('calendar.stat.dayStreak')} />
                <Stat n={fmtNumber(yearTotal)} label={t('calendar.stat.entries')} />
                <Stat n={fmtNumber(yearDays)} label={t('calendar.stat.days')} />
                {busiestMonth >= 0 && <Stat n={monthName(busiestMonth, 'short')} label={t('calendar.stat.mostActive')} />}
              </>
            ) : view === 'timeline' ? (
              <>
                <Stat n={fmtNumber(streak)} label={t('calendar.stat.dayStreak')} />
                <Stat n={fmtNumber(timeline.length)} label={t('calendar.stat.entries')} />
              </>
            ) : (
              <>
                <Stat n={fmtNumber(streak)} label={t('calendar.stat.dayStreak')} />
                <Stat n={fmtNumber(monthCount)} label={t('calendar.stat.entries')} />
                <Stat n={compactCount(words)} label={t('calendar.stat.words')} />
              </>
            )}
            <div style={{ flex: 1 }} />
            <CalTabs view={view} onView={setView} />
          </div>
        </div>

        {view === 'month' && (
          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '20px 28px', minWidth: 0 }}>
              <div style={{ flex: 1, minHeight: 0 }}><CalGrid big {...gridProps} /></div>
            </div>
            <div style={{ width: 340, borderInlineStart: '1px solid var(--line)', display: 'flex', flexDirection: 'column', background: 'var(--surface-2)' }}>
              <div style={{ padding: '20px 22px 14px' }}>
                <div style={{ fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--ink-3)' }}>
                  {fmtDate(Date.UTC(year, month, selected), { weekday: 'short', month: 'long', day: 'numeric', timeZone: 'UTC' })}
                </div>
                <div style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 500, color: 'var(--ink)', marginTop: 2 }}>{dayEntries.length ? tp('common.entries', dayEntries.length) : t('calendar.nothingYet')}</div>
              </div>
              <div style={{ flex: 1, overflow: 'auto', padding: '0 18px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {dayEntries.length ? dayEntries.map((e) => <EntryRow key={e.id} e={e} onOpen={onOpenEntry} compact resolve={resolveJournal} />) : <EmptyDay onNew={() => onOpenEntry('')} />}
                <OnThisDay matches={memories} onOpen={onOpenEntry} />
              </div>
              <div style={{ padding: '16px 20px', borderTop: '1px solid var(--line)' }}>
                <div style={{ fontFamily: 'var(--ui)', fontSize: 11.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 10 }}>{t('calendar.thisSeason')}</div>
                <Heatmap counts={heat} />
              </div>
            </div>
          </div>
        )}

        {view === 'year' && (
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: '18px 28px' }}>
            <CalYearOverview big {...yearProps} />
          </div>
        )}

        {view === 'timeline' && (
          <div style={{ flex: 1, overflow: 'auto', padding: '22px 0' }}>
            <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 28px' }}>
              <Timeline list={timeline} onOpen={onOpenEntry} resolve={resolveJournal} mediaThumb={mediaThumb} onNew={() => onOpenEntry('')} />
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── mobile ──
  return (
    <div style={{ height: '100%', overflow: 'auto', background: 'var(--paper)', paddingBottom: 84 }}>
      <div style={{ padding: 'calc(env(safe-area-inset-top, 0px) + 22px) 18px 0' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <ConnChip />
        </div>
        <CalNav {...navProps} />
        <div style={{ margin: '14px 0' }}><CalTabs full view={view} onView={setView} /></div>

        {view === 'month' && (
          <>
            <div style={{ display: 'flex', gap: 10, margin: '0 0 14px' }}>
              <Stat n={fmtNumber(streak)} label={t('calendar.stat.dayStreak')} boxed />
              <Stat n={fmtNumber(monthCount)} label={t('calendar.stat.entries')} boxed />
              <Stat n={compactCount(words)} label={t('calendar.stat.words')} boxed />
            </div>
            <div style={{ padding: 14, borderRadius: 18, background: 'var(--surface)', border: '1px solid var(--line)' }}>
              <CalGrid {...gridProps} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '22px 2px 12px' }}>
              <h3 style={{ fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, color: 'var(--ink)', margin: 0 }}>{fmtDate(Date.UTC(year, month, selected), { month: 'long', day: 'numeric', timeZone: 'UTC' })}</h3>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--ink-3)' }}>{tp('common.entries', dayEntries.length)}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {dayEntries.length ? dayEntries.map((e) => <EntryRow key={e.id} e={e} onOpen={onOpenEntry} resolve={resolveJournal} />) : <EmptyDay onNew={() => onOpenEntry('')} />}
              <OnThisDay matches={memories} onOpen={onOpenEntry} />
            </div>
          </>
        )}

        {view === 'year' && (
          <>
            <div style={{ display: 'flex', gap: 10, margin: '0 0 16px' }}>
              <Stat n={fmtNumber(yearTotal)} label={t('calendar.stat.entries')} boxed />
              <Stat n={fmtNumber(yearDays)} label={t('calendar.stat.days')} boxed />
              <Stat n={busiestMonth >= 0 ? monthName(busiestMonth, 'short') : '—'} label={t('calendar.stat.mostActive')} boxed />
            </div>
            <CalYearOverview {...yearProps} />
          </>
        )}

        {view === 'timeline' && (
          <div style={{ margin: '4px 0 0' }}>
            <Timeline list={timeline} onOpen={onOpenEntry} resolve={resolveJournal} mediaThumb={mediaThumb} onNew={() => onOpenEntry('')} />
          </div>
        )}
      </div>
    </div>
  );
}

// The month grid: weekday header + day cells. Module-level (not inline in
// CalendarScreen) so its component identity is stable across renders — Preact
// remounts the whole subtree when the element type changes.
function CalGrid({ big, meta, today, selected, onSelect, byDay, resolve }: {
  big?: boolean;
  meta: { offset: number; days: number };
  today: number;
  selected: number;
  onSelect: (d: number) => void;
  byDay: Map<number, CalEntry[]>;
  resolve: (id: string) => Journal | undefined;
}): VNode {
  return (
    <div style={big ? { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } : undefined}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: big ? 6 : 2, marginBottom: 6 }}>
        {Array.from({ length: 7 }).map((_, i) => (
          // Mon-first column order; weekdayName() takes 0=Sunday.
          <div key={i} style={{ textAlign: 'center', fontFamily: 'var(--ui)', fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: 'var(--ink-3)', textTransform: 'uppercase', padding: '2px 0' }}>{weekdayName((i + 1) % 7, big ? 'short' : 'narrow')}</div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: big ? 6 : 2, ...(big ? { flex: 1, minHeight: 0, gridAutoRows: 'minmax(0, 1fr)' } : {}) }}>
        {Array.from({ length: meta.offset }).map((_, i) => <div key={'b' + i} />)}
        {Array.from({ length: meta.days }).map((_, i) => (
          <Cell key={i} d={i + 1} today={today} selected={selected} onSelect={onSelect} big={big} dayEntries={byDay.get(i + 1) ?? []} resolve={resolve} />
        ))}
      </div>
    </div>
  );
}

// The shared title + quick-jump cluster. Steps by month in the month view and
// by year in the year view (onStep decides); timeline has no stepping.
function CalNav({ big, view, year, month, isCurrentMonth, todayY, timelineCount, onStep, onGoToday, onPickYear }: {
  big?: boolean;
  view: CalView;
  year: number;
  month: number;
  isCurrentMonth: boolean;
  todayY: number;
  timelineCount: number;
  onStep: (delta: number) => void;
  onGoToday: () => void;
  onPickYear: (y: number) => void;
}): VNode {
  const atToday = view === 'year' ? year === todayY : isCurrentMonth;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
        {view === 'timeline' ? (
          <h2 style={{ fontFamily: 'var(--serif)', fontSize: big ? 26 : 24, fontWeight: 500, color: 'var(--ink)', margin: 0 }}>{t('calendar.view.timeline')}</h2>
        ) : (
          <>
            {view === 'month' && <h2 style={{ fontFamily: 'var(--serif)', fontSize: big ? 26 : 24, fontWeight: 500, color: 'var(--ink)', margin: 0 }}>{monthName(month)}</h2>}
            <YearJump year={year} big={view === 'year'} onPick={onPickYear} />
          </>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {view === 'timeline' ? (
          <span style={{ fontFamily: 'var(--ui)', fontSize: 13, color: 'var(--ink-3)' }}>{tp('common.entries', timelineCount)}</span>
        ) : (
          <>
            {!atToday && <Btn kind="quiet" size="sm" onClick={onGoToday}>{view === 'year' ? t('calendar.thisYear') : t('common.today')}</Btn>}
            <button onClick={() => onStep(-1)} aria-label={t('calendar.previous')} style={navBtn}><Icon name="left" size={18} color="var(--ink-2)" dirFlip /></button>
            <button onClick={() => onStep(1)} aria-label={t('common.next')} style={navBtn}><Icon name="right" size={18} color="var(--ink-2)" dirFlip /></button>
          </>
        )}
      </div>
    </div>
  );
}

function CalTabs({ full, view, onView }: { full?: boolean; view: CalView; onView: (v: CalView) => void }): VNode {
  return (
    <div style={{ display: 'flex', gap: 2, padding: 3, borderRadius: 10, background: 'var(--surface)', border: '1px solid var(--line)', ...(full ? { width: '100%' } : {}) }}>
      <ViewTab active={view === 'month'} icon="cal" full={full} onClick={() => onView('month')}>{t('calendar.view.month')}</ViewTab>
      <ViewTab active={view === 'year'} icon="grid" full={full} onClick={() => onView('year')}>{t('calendar.view.year')}</ViewTab>
      <ViewTab active={view === 'timeline'} icon="timeline" full={full} onClick={() => onView('timeline')}>{t('calendar.view.timeline')}</ViewTab>
    </div>
  );
}

function CalYearOverview({ big, year, yearData, todayY, todayM, onOpenMonth }: {
  big?: boolean;
  year: number;
  yearData: { count: number; days: Map<number, number> }[];
  todayY: number;
  todayM: number;
  onOpenMonth: (m: number, day?: number) => void;
}): VNode {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: big ? 'repeat(4, 1fr)' : 'repeat(2, 1fr)', gridTemplateRows: big ? 'repeat(3, 1fr)' : undefined, gap: big ? 12 : 10, ...(big ? { height: '100%' } : {}) }}>
      {Array.from({ length: 12 }).map((_, m) => (
        <MiniMonth
          key={m}
          year={year}
          month={m}
          data={yearData[m]}
          big={big}
          isCurrent={year === todayY && m === todayM}
          onOpenMonth={onOpenMonth}
        />
      ))}
    </div>
  );
}

// One compact month in the year overview: a per-day activity heatmap. `big`
// makes the card fill its grid cell so the whole year fits one screen without
// scrolling. Tapping the header jumps to that month; tapping a day jumps there
// with the day selected.
function MiniMonth({ year, month, data, big, isCurrent, onOpenMonth }: {
  year: number;
  month: number;
  data: { count: number; days: Map<number, number> };
  big?: boolean;
  isCurrent: boolean;
  onOpenMonth: (m: number, day?: number) => void;
}): VNode {
  const meta = monthMeta(year, month);
  const dayMax = Math.max(1, ...data.days.values());
  const grid: JSX.CSSProperties = big
    ? { flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gridTemplateRows: 'repeat(6, minmax(0, 1fr))', gap: 3 }
    : { display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 3 };
  return (
    <div style={{ padding: big ? 12 : 11, borderRadius: 16, background: 'var(--surface)', border: `1px solid ${isCurrent ? 'var(--accent-line)' : 'var(--line)'}`, display: 'flex', flexDirection: 'column', gap: 9, minHeight: 0, ...(big ? { height: '100%' } : {}) }}>
      <button
        onClick={() => onOpenMonth(month, 1)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'start' }}
      >
        <span style={{ fontFamily: 'var(--serif)', fontSize: 15, fontWeight: 600, color: isCurrent ? 'var(--accent-ink)' : 'var(--ink)' }}>{monthName(month)}</span>
      </button>
      <div style={grid}>
        {Array.from({ length: meta.offset }).map((_, i) => <div key={'b' + i} />)}
        {Array.from({ length: meta.days }).map((_, i) => {
          const day = i + 1;
          const c = data.days.get(day) ?? 0;
          const intensity = c === 0 ? 0 : 0.28 + 0.72 * (c / dayMax);
          const dateLabel = fmtDate(Date.UTC(year, month, day), { month: 'short', day: 'numeric', timeZone: 'UTC' });
          return (
            <button
              key={day}
              onClick={() => onOpenMonth(month, day)}
              title={c ? tp('calendar.dayCount', c, { date: dateLabel }) : dateLabel}
              style={{
                ...(big ? {} : { aspectRatio: '1' }), borderRadius: 3, cursor: 'pointer', border: 'none', padding: 0, minHeight: big ? 6 : undefined,
                background: c ? hexA('#B0563A', intensity) : 'var(--surface-2)',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

// The global, cross-notebook timeline with month separators.
function Timeline({ list, onOpen, resolve, mediaThumb, onNew }: {
  list: JournalEntry[];
  onOpen: (id: string) => void;
  resolve: (id: string) => Journal | undefined;
  mediaThumb: (entryId: string, att: MediaAttachment) => Promise<Blob | null>;
  onNew: () => void;
}): VNode {
  if (list.length === 0) {
    return (
      <div style={{ padding: '40px 20px', borderRadius: 16, border: '1.5px dashed var(--line)', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
        <Icon name="timeline" size={26} color="var(--ink-3)" />
        <div style={{ fontFamily: 'var(--ui)', fontSize: 13.5, color: 'var(--ink-2)' }}>{t('calendar.empty.timeline')}</div>
        <Btn kind="soft" size="sm" icon="plus" onClick={onNew}>{t('calendar.empty.writeFirst')}</Btn>
      </div>
    );
  }
  let lastMonth = '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {list.flatMap((e) => {
        const d = new Date(e.createdAt);
        const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
        const sep = key !== lastMonth;
        lastMonth = key;
        const j = resolve(e.journalId);
        const images = entryImages(e);
        return [
          sep && (
            <div key={`m-${key}`} style={{ padding: '14px 2px 4px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>
                {fmtDate(d, { month: 'long', year: 'numeric', timeZone: 'UTC' })}
              </span>
              <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
            </div>
          ),
          <button
            key={e.id}
            onClick={() => onOpen(e.id)}
            style={{ textAlign: 'start', cursor: 'pointer', padding: '13px 15px', borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--line)', borderInlineStart: `3px solid ${j?.color ?? 'var(--ink-3)'}`, transition: 'border-color .14s' }}
            onMouseEnter={(ev) => (ev.currentTarget.style.borderColor = hexA(j?.color ?? '#999999', 0.5), ev.currentTarget.style.borderInlineStartColor = j?.color ?? 'var(--ink-3)')}
            onMouseLeave={(ev) => (ev.currentTarget.style.borderColor = 'var(--line)', ev.currentTarget.style.borderInlineStartColor = j?.color ?? 'var(--ink-3)')}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontFamily: 'var(--serif)', fontSize: 16.5, fontWeight: 500, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.title || t('common.untitled')}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', flexShrink: 0 }}>{timelineDate(d)}</span>
            </div>
            {e.bodyText && (
              <p style={{ fontFamily: 'var(--ui)', fontSize: 13, color: 'var(--ink-2)', margin: '4px 0 0', lineHeight: 1.45, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{e.bodyText}</p>
            )}
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--ink-3)' }}>{j?.name}</span>
              {e.labels.map((l) => <LabelChip key={l} id={l} size="sm" />)}
            </div>
            <EntryThumbs images={images} resolve={(att) => mediaThumb(e.id, att)} size={40} />
          </button>,
        ];
      })}
    </div>
  );
}

function Stat({ n, label, boxed }: { n: string; label: string; boxed?: boolean }): VNode {
  if (boxed) {
    return (
      <div style={{ flex: 1, padding: '10px 12px', borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--line)' }}>
        <div style={{ fontFamily: 'var(--serif)', fontSize: 21, fontWeight: 600, color: 'var(--ink)' }}>{n}</div>
        <div style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--ink-3)' }}>{label}</div>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
      <span style={{ fontFamily: 'var(--serif)', fontSize: 22, fontWeight: 600, color: 'var(--ink)' }}>{n}</span>
      <span style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--ink-3)' }}>{label}</span>
    </div>
  );
}

function ViewTab({ children, active, icon, full, onClick }: { children: ComponentChildren; active?: boolean; icon: IconName; full?: boolean; onClick: () => void }): VNode {
  return (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontFamily: 'var(--ui)', fontSize: 13, fontWeight: 600, padding: '6px 12px', borderRadius: 8, cursor: 'pointer', border: 'none', background: active ? 'var(--paper)' : 'transparent', color: active ? 'var(--ink)' : 'var(--ink-3)', boxShadow: active ? '0 1px 2px rgba(0,0,0,.06)' : 'none', ...(full ? { flex: 1 } : {}) }}>
      <Icon name={icon} size={15} /> {children}
    </button>
  );
}

// Clickable year that drops a small decade grid for fast jumps across years.
function YearJump({ year, big, onPick }: { year: number; big?: boolean; onPick: (y: number) => void }): VNode {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(Math.floor(year / 12) * 12);
  useEffect(() => { if (open) setPage(Math.floor(year / 12) * 12); }, [open, year]);
  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', cursor: 'pointer', padding: '2px 4px', borderRadius: 8, fontFamily: big ? 'var(--serif)' : 'var(--ui)', fontSize: big ? 26 : 16, fontWeight: big ? 500 : 500, color: big ? 'var(--ink)' : 'var(--ink-3)' }}
      >
        {year}
        <Icon name="down" size={big ? 16 : 13} color="var(--ink-3)" />
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{ position: 'absolute', top: '100%', insetInlineStart: 0, marginTop: 6, zIndex: 41, width: 260, padding: 12, borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--line)', boxShadow: '0 10px 30px rgba(0,0,0,.14)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <button onClick={() => setPage((p) => p - 12)} aria-label={t('calendar.previous')} style={navBtnSm}><Icon name="left" size={15} color="var(--ink-2)" dirFlip /></button>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--ink-2)' }}>{page}–{page + 11}</span>
              <button onClick={() => setPage((p) => p + 12)} aria-label={t('common.next')} style={navBtnSm}><Icon name="right" size={15} color="var(--ink-2)" dirFlip /></button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
              {Array.from({ length: 12 }).map((_, i) => {
                const y = page + i;
                const sel = y === year;
                return (
                  <button
                    key={y}
                    onClick={() => { onPick(y); setOpen(false); }}
                    style={{ padding: '9px 0', borderRadius: 9, cursor: 'pointer', fontFamily: 'var(--ui)', fontSize: 13, fontWeight: sel ? 700 : 500, background: sel ? 'var(--accent)' : 'transparent', color: sel ? '#fff' : 'var(--ink)', border: `1px solid ${sel ? 'var(--accent)' : 'var(--line)'}` }}
                  >
                    {y}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function OnThisDay({ matches, onOpen }: { matches: JournalEntry[]; onOpen: (id: string) => void }): VNode | null {
  if (!matches.length) return null;
  return (
    <div style={{ padding: '13px 14px', borderRadius: 14, background: 'var(--surface)', border: '1px solid var(--line)' }}>
      <div style={{ fontFamily: 'var(--ui)', fontSize: 11.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 8 }}>{t('calendar.onThisDay')}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {matches.slice(0, 3).map((e) => (
          <button
            key={e.id}
            onClick={() => onOpen(e.id)}
            style={{ display: 'flex', gap: 12, width: '100%', textAlign: 'start', cursor: 'pointer', alignItems: 'baseline', background: 'transparent', border: 'none', padding: 0 }}
          >
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)', fontWeight: 500, minWidth: 42 }}>{new Date(e.createdAt).getUTCFullYear()}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontFamily: 'var(--serif)', fontSize: 15, fontWeight: 500, color: 'var(--ink)' }}>{e.title}</span>
              <span style={{ display: '-webkit-box', fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--ink-2)', margin: '2px 0 0', lineHeight: 1.5, overflow: 'hidden', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical' }}>{e.bodyText}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function EmptyDay({ onNew }: { onNew: () => void }): VNode {
  return (
    <div style={{ padding: '30px 20px', borderRadius: 16, border: '1.5px dashed var(--line)', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
      <Icon name="feather" size={26} color="var(--ink-3)" />
      <div style={{ fontFamily: 'var(--ui)', fontSize: 13.5, color: 'var(--ink-2)' }}>{t('calendar.empty.day')}</div>
      <Btn kind="soft" size="sm" icon="plus" onClick={onNew}>{t('calendar.empty.write')}</Btn>
    </div>
  );
}

const navBtn = { width: 36, height: 36, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' } as const;
const navBtnSm = { width: 28, height: 28, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' } as const;
