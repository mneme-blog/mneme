import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Icon } from './Icon';
import { Btn } from './primitives';
import { Sheet, Z } from './Sheet';
import { t, fmtDate, monthName, weekdayName } from '../i18n';

// The editor's date/time metadata line, made editable: clicking it opens a
// month-grid + time picker so an entry can be re-dated (e.g. written the
// morning after). All math is local time — this edits exactly the local-time
// label the editor header shows. createdAt travels inside the encrypted entry
// body, so the relay never sees the chosen date (§3).

const pad = (n: number): string => String(n).padStart(2, '0');

function monthMeta(year: number, month: number): { offset: number; days: number } {
  const first = new Date(year, month, 1).getDay(); // 0=Sun
  return { offset: (first + 6) % 7, days: new Date(year, month + 1, 0).getDate() }; // Mon-first
}

function dateLabel(d: Date): string {
  return fmtDate(d, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function timeLabel(d: Date): string {
  return fmtDate(d, { hour: 'numeric', minute: '2-digit' });
}

export function EntryDateTime({ value, desk, onChange }: { value: number; desk: boolean; onChange: (ts: number) => void }): VNode {
  const [open, setOpen] = useState(false);
  const d = new Date(value);
  return (
    <>
      <button
        title={t('editor.date.change')}
        onClick={() => setOpen(true)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'transparent', border: 'none', borderRadius: 8, padding: '3px 8px', margin: '-3px -8px', cursor: 'pointer', color: 'var(--ink-2)', transition: 'all .14s' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; e.currentTarget.style.color = 'var(--ink)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--ink-2)'; }}
      >
        <Icon name="clock" size={15} />
        <span style={{ fontFamily: 'var(--serif)', fontSize: desk ? 16.5 : 15.5, fontWeight: 500 }}>
          {dateLabel(d)} <span style={{ color: 'var(--ink-3)' }}>· {timeLabel(d)}</span>
        </span>
        <Icon name="down" size={13} />
      </button>
      {open && (
        <DateTimeSheet
          value={value}
          desk={desk}
          onClose={() => setOpen(false)}
          onSave={(ts) => {
            setOpen(false);
            if (ts !== value) onChange(ts);
          }}
        />
      )}
    </>
  );
}

function DateTimeSheet({ value, desk, onClose, onSave }: { value: number; desk: boolean; onClose: () => void; onSave: (ts: number) => void }): VNode {
  const [draft, setDraft] = useState(() => new Date(value));
  const [view, setView] = useState(() => ({ y: new Date(value).getFullYear(), m: new Date(value).getMonth() }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const now = new Date();
  const meta = monthMeta(view.y, view.m);
  const isCurrentMonth = view.y === now.getFullYear() && view.m === now.getMonth();
  const selDay = draft.getFullYear() === view.y && draft.getMonth() === view.m ? draft.getDate() : -1;
  const todayDay = isCurrentMonth ? now.getDate() : -1;

  const nav = (dir: number): void =>
    setView((v) => {
      const a = v.m + dir;
      return { y: v.y + Math.floor(a / 12), m: ((a % 12) + 12) % 12 };
    });
  const pickDay = (day: number): void =>
    setDraft((prev) => new Date(view.y, view.m, day, prev.getHours(), prev.getMinutes()));
  const setTime = (hhmm: string): void => {
    const [h, m] = hhmm.split(':').map(Number);
    setDraft((prev) => new Date(prev.getFullYear(), prev.getMonth(), prev.getDate(), h || 0, m || 0));
  };
  // Reset to the current moment — also snaps the calendar back to this month.
  const toNow = (): void => {
    const n = new Date();
    n.setSeconds(0, 0);
    setDraft(n);
    setView({ y: n.getFullYear(), m: n.getMonth() });
  };

  return (
    <Sheet
      desk={desk}
      onClose={onClose}
      zIndex={Z.overlay}
      width={380}
      cardStyle={{ padding: desk ? 24 : '18px 22px calc(env(safe-area-inset-bottom, 0px) + 26px)' }}
    >
      <div style={{ fontFamily: 'var(--ui)', fontSize: 11.5, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: 'var(--ink-3)' }}>{t('editor.date.heading')}</div>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, color: 'var(--ink)', margin: '3px 0 16px' }}>
        {dateLabel(draft)} · {timeLabel(draft)}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 500, color: 'var(--ink)' }}>{monthName(view.m)}</span>
          <span style={{ fontFamily: 'var(--ui)', fontSize: 14, color: 'var(--ink-3)' }}>{view.y}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          {!isCurrentMonth && (
            <Btn kind="quiet" size="sm" onClick={() => setView({ y: now.getFullYear(), m: now.getMonth() })}>{t('common.today')}</Btn>
          )}
          <button onClick={() => nav(-1)} style={navBtn}><Icon name="left" size={17} color="var(--ink-2)" dirFlip /></button>
          <button onClick={() => nav(1)} style={navBtn}><Icon name="right" size={17} color="var(--ink-2)" dirFlip /></button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
        {/* Mon-first columns; getDay() has 0=Sunday, so column i is weekday (i+1)%7. */}
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} style={{ textAlign: 'center', fontFamily: 'var(--ui)', fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, color: 'var(--ink-3)', textTransform: 'uppercase', padding: '2px 0' }}>{weekdayName((i + 1) % 7, 'narrow')}</div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {Array.from({ length: meta.offset }).map((_, i) => <div key={'b' + i} />)}
        {Array.from({ length: meta.days }).map((_, i) => {
          const day = i + 1;
          const isSel = day === selDay;
          const isToday = day === todayDay;
          return (
            <button
              key={day}
              onClick={() => pickDay(day)}
              style={{
                aspectRatio: '1', borderRadius: 999, padding: 0, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: isSel ? 'var(--accent)' : 'transparent',
                border: isToday && !isSel ? '1.5px solid var(--accent)' : '1.5px solid transparent',
                fontFamily: 'var(--ui)', fontSize: 13.5, fontWeight: isSel || isToday ? 700 : 500,
                color: isSel ? '#fff' : isToday ? 'var(--accent-ink)' : 'var(--ink)',
                transition: 'all .12s',
              }}
            >
              {day}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
        <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase', color: 'var(--ink-3)' }}>{t('editor.date.time')}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="time"
            value={`${pad(draft.getHours())}:${pad(draft.getMinutes())}`}
            onInput={(e) => setTime((e.target as HTMLInputElement).value)}
            style={{ fontFamily: 'var(--mono)', fontSize: 15, padding: '7px 10px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--paper)', color: 'var(--ink)', outline: 'none' }}
          />
          <Btn kind="soft" size="sm" onClick={toNow}>{t('editor.date.now')}</Btn>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
        <Btn kind="ghost" onClick={onClose} style={{ flex: 1 }}>{t('common.cancel')}</Btn>
        <Btn kind="primary" onClick={() => onSave(draft.getTime())} style={{ flex: 2 }}>{t('editor.date.set')}</Btn>
      </div>
    </Sheet>
  );
}

const navBtn = { width: 32, height: 32, borderRadius: 10, border: '1px solid var(--line)', background: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' } as const;
