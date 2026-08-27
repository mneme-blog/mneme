// Preferences overlay — the one settings surface, organized into four tabs:
// Appearance (language + light/dark/system mode + theme skin + accent),
// Writing (local stats), Assistant (templates / ask / AI settings), and Vault
// (identity, lock, phrase rotation, deletion). Desktop shows a left nav rail
// beside a scrolling content pane; mobile shows a segmented tab bar atop the
// sheet. Appearance state (language included) is device-local localStorage
// and never syncs; the vault rows just hand off to their existing sheets
// (RotatePhrase, DeleteVault…).
import type { VNode } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { Icon, type IconName } from './Icon';
import { Btn, ConnectionDot, connLabel } from './primitives';
import { SheetBackdrop, SheetGrabber, Z } from './Sheet';
import { useAppData, type SyncStatus } from '../state/data';
import { normalizeRelayUrl } from '../sync/relay';
import { PALETTES, SKINS, type ThemeControls, type ThemeMode } from '../hooks/useTheme';
import { compactCount, dayStreak, journaledDays, longestStreak, monthWords, totalWords } from '../state/stats';
import { BADGE_ORDER, evaluateBadges } from '../state/badges';
import { BadgeMedallion, badgeName, badgeDesc } from './BadgeCelebration';
import { APP_VERSION, buildTimeLabel } from '../buildinfo';
import { hexA } from './color';
import { fmtNumber, t, useI18n, type MessageKey } from '../i18n';
import { deepReflectionEnabled, setDeepReflection } from '../ai/reflection';
import {
  ANSWER_LIMITS,
  VIDEO_QUALITY,
  answerLimitSeconds,
  fmtDuration,
  megabytesPerMinute,
  setAnswerLimitSeconds,
  setVideoQuality,
  videoQuality,
} from './recorder';

const MODES: { id: ThemeMode; icon: IconName }[] = [
  { id: 'light', icon: 'sun' },
  { id: 'dark', icon: 'moon' },
  { id: 'system', icon: 'monitor' },
];

type TabId = 'appearance' | 'writing' | 'assistant' | 'vault' | 'info';
// The `.short` catalog variant is the mobile segmented label — full words
// don't fit four-across on a phone, so the desktop rail uses the full label
// and the bottom sheet uses the short one.
const TABS: { id: TabId; icon: IconName }[] = [
  { id: 'appearance', icon: 'eye' },
  { id: 'writing', icon: 'book' },
  { id: 'assistant', icon: 'feather' },
  { id: 'vault', icon: 'shield' },
  { id: 'info', icon: 'info' },
];

/** Camera capture settings. Both knobs are device-local localStorage (see
    ui/recorder.ts for why they are not fields on InterviewType), so this holds
    its own state rather than reading from the synced app data. */
function VideoSection({ desk }: { desk: boolean }): VNode {
  const [quality, setQuality] = useState(videoQuality);
  const [limit, setLimit] = useState(answerLimitSeconds);

  return (
    <div>
      <SectionLabel>{t('prefs.video.section')}</SectionLabel>
      <div style={{ fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--ink-2)', margin: '0 2px 8px' }}>
        {t('prefs.video.quality')}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {(['low', 'medium', 'high'] as const).map((q) => {
          const active = quality === q;
          return (
            <button
              key={q}
              onClick={() => { setVideoQuality(q); setQuality(q); }}
              style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, padding: '11px 4px 9px', borderRadius: 12, cursor: 'pointer', border: `1px solid ${active ? 'var(--accent-line)' : 'var(--line)'}`, background: active ? 'var(--accent-soft)' : 'var(--paper)', color: active ? 'var(--accent-ink)' : 'var(--ink-2)', fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: active ? 700 : 500 }}
            >
              {/* Ids mirror the 'prefs.video.quality.*' catalog entries. */}
              <span>{t(`prefs.video.quality.${q}` as MessageKey)}</span>
              {/* The two numbers that actually decide this: frame size, and what
                  a minute of it costs on disk and in the vault quota. */}
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: active ? 'var(--accent-ink)' : 'var(--ink-3)', whiteSpace: 'nowrap' }}>
                {VIDEO_QUALITY[q].width}×{VIDEO_QUALITY[q].height}
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>
                {t('prefs.video.perMinute', { mb: fmtNumber(megabytesPerMinute(q)) })}
              </span>
            </button>
          );
        })}
      </div>
      <p style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--ink-3)', margin: '8px 2px 0', lineHeight: 1.5 }}>
        {t('prefs.video.quality.hint')}
      </p>

      <div style={{ fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--ink-2)', margin: '16px 2px 8px' }}>
        {t('prefs.video.limit')}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: desk ? 'repeat(5, 1fr)' : 'repeat(3, 1fr)', gap: 8 }}>
        {ANSWER_LIMITS.map((s) => {
          const active = limit === s;
          return (
            <button
              key={s}
              onClick={() => { setAnswerLimitSeconds(s); setLimit(s); }}
              style={{ padding: '10px 4px', borderRadius: 12, cursor: 'pointer', border: `1px solid ${active ? 'var(--accent-line)' : 'var(--line)'}`, background: active ? 'var(--accent-soft)' : 'var(--paper)', color: active ? 'var(--accent-ink)' : 'var(--ink-2)', fontFamily: 'var(--mono)', fontSize: 12.5, fontWeight: active ? 700 : 500 }}
            >
              {/* "M:SS" — digits only, so it needs no translation. */}
              {fmtDuration(s * 1000)}
            </button>
          );
        })}
      </div>
      <p style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--ink-3)', margin: '8px 2px 0', lineHeight: 1.5 }}>
        {t('prefs.video.limit.hint')}
      </p>
    </div>
  );
}

/** Interview settings. The deeper-questions opt-in is device-local like the
    camera knobs below it (ai/reflection.ts explains why a consent about what
    leaves THIS device is not synced), so this holds its own state too. The same
    switch is what the one-time overlay writes on the first AI interview —
    here it can be reconsidered, with the same explanation attached. */
function InterviewSection(): VNode {
  const [deep, setDeep] = useState(deepReflectionEnabled);

  return (
    <div>
      <SectionLabel>{t('prefs.interviews.section')}</SectionLabel>
      <button
        onClick={() => { setDeepReflection(!deep); setDeep(!deep); }}
        role="switch"
        aria-checked={deep}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 14px', borderRadius: 12, background: 'var(--paper)', border: '1px solid var(--line)', cursor: 'pointer', textAlign: 'start' }}
      >
        <span style={{ fontFamily: 'var(--ui)', fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{t('prefs.interviews.deep')}</span>
        <span style={{ width: 38, height: 22, borderRadius: 99, flexShrink: 0, background: deep ? 'var(--accent)' : 'var(--line)', position: 'relative', transition: 'background .15s' }}>
          <span style={{ position: 'absolute', top: 2, insetInlineStart: deep ? 18 : 2, width: 18, height: 18, borderRadius: 99, background: 'var(--surface)', transition: 'inset-inline-start .15s' }} />
        </span>
      </button>
      {/* What it does, then what it costs in data — the same two halves as the
          consent overlay, because a setting the user meets here first has to
          carry the disclosure too. */}
      <p style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--ink-3)', margin: '8px 2px 0', lineHeight: 1.5 }}>
        {t('prefs.interviews.deepHint')}
      </p>
      <p style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--ink-3)', margin: '6px 2px 0', lineHeight: 1.5 }}>
        {t('prefs.interviews.deepData')}
      </p>
    </div>
  );
}

/** Group heading inside a tab pane; `first` drops the top margin so a pane
    doesn't open with a double gap above its first group. */
function SectionLabel({ children, first }: { children: string; first?: boolean }): VNode {
  return (
    <div style={{ fontFamily: 'var(--ui)', fontSize: 11, fontWeight: 700, letterSpacing: 0.7, textTransform: 'uppercase', color: 'var(--ink-3)', margin: first ? '0 2px 8px' : '20px 2px 8px' }}>
      {children}
    </div>
  );
}

function StatTile({ value, label }: { value: string; label: string }): VNode {
  return (
    <div style={{ background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 12, padding: '11px 13px', minWidth: 0 }}>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 25, fontWeight: 600, color: 'var(--ink)', lineHeight: 1.1, whiteSpace: 'nowrap' }}>{value}</div>
      <div style={{ fontFamily: 'var(--ui)', fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--ink-3)', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
    </div>
  );
}

/** Read-only label/value line in the Info tab's grouped card. */
function InfoRow({ label, value, last }: { label: string; value: string; last?: boolean }): VNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '11px 13px', borderBottom: last ? 'none' : '1px solid var(--line)' }}>
      <span style={{ fontFamily: 'var(--ui)', fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)', textAlign: 'end' }}>{value}</span>
    </div>
  );
}

/** Action row in the mobile-settings style; `danger` tints label + icon. */
function Row({ icon, label, value, danger, onClick }: {
  icon: IconName;
  label: string;
  value?: string;
  danger?: boolean;
  onClick: () => void;
}): VNode {
  return (
    <button
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'start', cursor: 'pointer', padding: '12px 14px', borderRadius: 12, border: '1px solid var(--line)', background: 'var(--paper)', fontFamily: 'var(--ui)', fontSize: 13.5, fontWeight: 600, color: danger ? 'var(--accent-ink)' : 'var(--ink)' }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent-line)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--line)'; }}
    >
      <Icon name={icon} size={17} color={danger ? 'var(--accent)' : 'var(--ink-2)'} />
      <span style={{ flex: 1 }}>{label}</span>
      {value && <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--ink-3)' }}>{value}</span>}
      <Icon name="right" size={15} color="var(--ink-3)" dirFlip />
    </button>
  );
}

/** Relay server URL — a runtime setting for self-hosters, and required under
    Tauri (no dev-server origin to infer it from). Collapsed to a Row that shows
    the current host; expands to an inline editor. Empty reverts to the default. */
function RelayServerRow(): VNode {
  const { relayUrl, setRelayUrl } = useAppData();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(relayUrl);
  const [error, setError] = useState<string | null>(null);

  let host = relayUrl;
  try {
    host = new URL(relayUrl).host;
  } catch {
    /* not a parseable URL — show the raw value */
  }

  const close = (): void => {
    setOpen(false);
    setError(null);
  };

  if (!open) {
    return (
      <Row
        icon="link"
        label={t('prefs.relay')}
        value={host}
        onClick={() => {
          setDraft(relayUrl);
          setOpen(true);
        }}
      />
    );
  }

  const save = (): void => {
    if (!draft.trim()) {
      setRelayUrl(null); // empty reverts to the build-time default
      close();
      return;
    }
    // Reject anything fetch() couldn't hit as an absolute http(s) URL — a bare
    // host would resolve relative to the app origin and fail as a silent 404.
    const normalized = normalizeRelayUrl(draft);
    if (!normalized) {
      setError(t('prefs.relay.invalid'));
      return;
    }
    setRelayUrl(normalized);
    close();
  };

  return (
    <div style={{ padding: '12px 14px', borderRadius: 12, border: '1px solid var(--accent-line)', background: 'var(--paper)', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={{ fontFamily: 'var(--ui)', fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--ink-3)' }}>{t('prefs.relay.urlLabel')}</span>
      <input
        value={draft}
        onInput={(e) => {
          setDraft((e.currentTarget as HTMLInputElement).value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          else if (e.key === 'Escape') close();
        }}
        placeholder="https://relay.example.com"
        spellcheck={false}
        autocomplete="off"
        autocapitalize="off"
        style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--ink)', background: 'var(--surface)', border: error ? '1px solid var(--accent)' : '1px solid var(--line)', borderRadius: 8, padding: '9px 11px' }}
      />
      {error && (
        <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--accent-ink)', lineHeight: 1.45 }}>{error}</span>
      )}
      <span style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-3)', lineHeight: 1.45 }}>
        {t('prefs.relay.help')}
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <Btn size="sm" onClick={save} style={{ flex: 1 }}>{t('common.save')}</Btn>
        <Btn size="sm" kind="ghost" onClick={close} style={{ flex: 1 }}>{t('common.cancel')}</Btn>
      </div>
    </div>
  );
}

export function PreferencesSheet({ desk, theme, onClose, ownerId, status, onLock, onRotate, onDeviceUnlock, onImport, onDeleteVault, onAiSettings, onTemplates, onAsk, onInterview, onInterviewTypes }: {
  desk: boolean;
  theme: ThemeControls;
  onClose: () => void;
  ownerId: string | null;
  status: SyncStatus;
  onLock: () => void;
  onRotate: () => void;
  onDeviceUnlock: () => void;
  onImport: () => void;
  onDeleteVault: () => void;
  onAiSettings: () => void;
  /** Mobile-only journal entry points (desktop reaches these from the sidebar). */
  onTemplates?: () => void;
  /** null hides the row (assistant disabled); undefined = desktop, sidebar has it. */
  onAsk?: (() => void) | null;
  /** Mobile-only (desktop has the sidebar button); null hides it when assistant is off. */
  onInterview?: (() => void) | null;
  /** Interview-types manager — reached from Preferences on both desktop and mobile; null when assistant is off. */
  onInterviewTypes?: (() => void) | null;
}): VNode {
  const { entries, vaultMethod, interviewTypes } = useAppData();
  const i18n = useI18n();
  const [tab, setTab] = useState<TabId>('appearance');
  // Vault rows hand off to full-screen sheets — close this overlay first.
  const handOff = (fn: () => void) => () => {
    onClose();
    fn();
  };

  // The context's `entries` are already live-only (the provider filters
  // tombstones); day math is UTC like the calendar grid, so streaks here and
  // there always agree.
  const stats = useMemo(() => {
    const live = entries;
    const now = Date.now();
    const d = new Date(now);
    return {
      entries: live.length,
      words: totalWords(live),
      streak: dayStreak(live, now),
      longest: longestStreak(live),
      days: journaledDays(live),
      month: monthWords(live, d.getUTCFullYear(), d.getUTCMonth()),
    };
  }, [entries]);

  // Gallery state only — the pure evaluation, not useBadges(): a second
  // stateful instance would race app.tsx's catch-up writes to localStorage.
  const earnedBadges = useMemo(
    () => evaluateBadges(entries, interviewTypes.filter((it) => !it.deleted).map((it) => it.name)),
    [entries, interviewTypes],
  );

  const appearance = (
    <div>
      <SectionLabel first>{t('prefs.language')}</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: desk ? 'repeat(3, 1fr)' : 'repeat(2, 1fr)', gap: 8 }}>
        {i18n.locales.map((l) => {
          const active = i18n.locale === l.id;
          return (
            <button
              key={l.id}
              lang={l.id}
              onClick={() => void i18n.setLocale(l.id)}
              title={l.english}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 12px', borderRadius: 12, cursor: 'pointer', border: `1px solid ${active ? 'var(--accent-line)' : 'var(--line)'}`, background: active ? 'var(--accent-soft)' : 'var(--paper)', color: active ? 'var(--accent-ink)' : 'var(--ink-2)', fontFamily: 'var(--ui)', fontSize: 13, fontWeight: active ? 700 : 500 }}
            >
              <span style={{ flex: 1, textAlign: 'start' }}>{l.name}</span>
              {active && <Icon name="check" size={13} stroke={2.4} />}
            </button>
          );
        })}
      </div>
      <p style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-3)', margin: '8px 2px 0', lineHeight: 1.5 }}>
        {t('prefs.language.hint')}
      </p>

      <SectionLabel>{t('prefs.mode')}</SectionLabel>
      <div style={{ display: 'flex', gap: 8 }}>
        {MODES.map((m) => {
          const active = theme.mode === m.id;
          return (
            <button
              key={m.id}
              onClick={() => theme.setMode(m.id)}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '12px 0 10px', borderRadius: 12, cursor: 'pointer', border: `1px solid ${active ? 'var(--accent-line)' : 'var(--line)'}`, background: active ? 'var(--accent-soft)' : 'var(--paper)', color: active ? 'var(--accent-ink)' : 'var(--ink-2)', fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: active ? 700 : 500 }}
            >
              <Icon name={m.icon} size={18} />
              {/* Ids mirror the 'prefs.mode.*' catalog entries. */}
              {t(`prefs.mode.${m.id}` as MessageKey)}
            </button>
          );
        })}
      </div>
      {theme.mode === 'system' && (
        <p style={{ fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-3)', margin: '8px 2px 0' }}>
          {t(theme.dark ? 'prefs.mode.followsDark' : 'prefs.mode.followsLight')}
        </p>
      )}

      <SectionLabel>{t('prefs.theme')}</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: desk ? 'repeat(3, 1fr)' : 'repeat(2, 1fr)', gap: 8 }}>
        {SKINS.map((s) => {
          const active = theme.skin === s.id;
          return (
            <button
              key={s.id}
              onClick={() => theme.setSkin(s.id)}
              title={t(`prefs.skin.${s.id}.hint` as MessageKey)}
              style={{ display: 'flex', flexDirection: 'column', gap: 0, padding: 0, overflow: 'hidden', borderRadius: 12, cursor: 'pointer', textAlign: 'start', border: `1.5px solid ${active ? 'var(--accent)' : 'var(--line)'}`, background: active ? 'var(--accent-soft)' : 'var(--paper)' }}
            >
              {/* Mini preview in the skin's signature colors, mode-independent. */}
              <span style={{ display: 'block', width: '100%', height: 44, boxSizing: 'border-box', background: s.preview.bg, padding: '9px 10px', borderBottom: `1px solid ${active ? 'var(--accent-line)' : 'var(--line)'}` }}>
                <span style={{ display: 'block', width: '55%', height: 5, borderRadius: 3, background: s.preview.ink, opacity: 0.85 }} />
                <span style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 999, background: s.preview.accent, flexShrink: 0 }} />
                  <span style={{ display: 'block', flex: 1, maxWidth: '70%', height: 4, borderRadius: 3, background: s.preview.ink, opacity: 0.3 }} />
                </span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '7px 10px', fontFamily: 'var(--ui)', fontSize: 12, fontWeight: active ? 700 : 600, color: active ? 'var(--accent-ink)' : 'var(--ink-2)' }}>
                {t(`prefs.skin.${s.id}` as MessageKey)}
                {active && <Icon name="check" size={12} stroke={2.4} />}
              </span>
            </button>
          );
        })}
      </div>

      <SectionLabel>{t('prefs.accent')}</SectionLabel>
      <div style={{ display: 'flex', gap: desk ? 10 : 6, justifyContent: 'space-between' }}>
        {PALETTES.map((p) => {
          const active = theme.palette === p.id;
          return (
            <button
              key={p.id}
              onClick={() => theme.setPalette(p.id)}
              title={t(`prefs.palette.${p.id}` as MessageKey)}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, padding: '10px 0 8px', borderRadius: 12, cursor: 'pointer', border: `1px solid ${active ? 'var(--accent-line)' : 'var(--line)'}`, background: active ? 'var(--accent-soft)' : 'var(--paper)' }}
            >
              <span style={{ width: 26, height: 26, borderRadius: 999, background: p.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: active ? `0 0 0 2px var(--surface), 0 0 0 4px ${hexA(p.accent, 0.55)}` : 'none' }}>
                {active && <Icon name="check" size={13} color="#fff" stroke={2.4} />}
              </span>
              <span style={{ fontFamily: 'var(--ui)', fontSize: 10.5, fontWeight: active ? 700 : 500, color: active ? 'var(--accent-ink)' : 'var(--ink-3)' }}>{t(`prefs.palette.${p.id}` as MessageKey)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const writing = (
    <div>
      <SectionLabel first>{t('prefs.writing.section')}</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: desk ? 'repeat(3, 1fr)' : 'repeat(2, 1fr)', gap: 8 }}>
        <StatTile value={compactCount(stats.entries)} label={t('prefs.stat.entries')} />
        <StatTile value={compactCount(stats.words)} label={t('prefs.stat.words')} />
        <StatTile value={compactCount(stats.month)} label={t('prefs.stat.month')} />
        <StatTile value={String(stats.streak)} label={t('prefs.stat.streak')} />
        <StatTile value={String(stats.longest)} label={t('prefs.stat.longest')} />
        <StatTile value={compactCount(stats.days)} label={t('prefs.stat.days')} />
      </div>
      <p style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--ink-3)', margin: '12px 2px 0', lineHeight: 1.5 }}>
        {t('prefs.writing.note')}
      </p>

      <SectionLabel>{t('badges.gallery.title')}</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: desk ? 'repeat(4, 1fr)' : 'repeat(2, 1fr)', gap: 8 }}>
        {BADGE_ORDER.map((id) => {
          const has = earnedBadges.has(id);
          return (
            <div
              key={id}
              title={badgeDesc(id)}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '14px 8px 12px', borderRadius: 12, border: `1px solid ${has ? 'var(--accent-line)' : 'var(--line)'}`, background: has ? 'var(--accent-soft)' : 'var(--paper)', textAlign: 'center' }}
            >
              <BadgeMedallion earned={has} size={44} />
              <span style={{ fontFamily: 'var(--ui)', fontSize: 11.5, fontWeight: has ? 700 : 500, color: has ? 'var(--accent-ink)' : 'var(--ink-3)', lineHeight: 1.3 }}>{badgeName(id)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );

  const assistant = (
    <div>
      <SectionLabel first>{t('prefs.assistant.section')}</SectionLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {onTemplates && <Row icon="copy" label={t('prefs.assistant.templates')} onClick={handOff(onTemplates)} />}
        {onAsk && <Row icon="feather" label={t('prefs.assistant.ask')} onClick={handOff(onAsk)} />}
        {onInterview && <Row icon="mic" label={t('prefs.assistant.interview')} onClick={handOff(onInterview)} />}
        {onInterviewTypes && <Row icon="list" label={t('prefs.assistant.interviewTypes')} onClick={handOff(onInterviewTypes)} />}
        <Row icon="feather" label={t('prefs.assistant.ai')} onClick={handOff(onAiSettings)} />
      </div>
      <InterviewSection />
      <VideoSection desk={desk} />
    </div>
  );

  const vault = (
    <div>
      <SectionLabel first>{t('prefs.vault.section')}</SectionLabel>
      <div title={ownerId ? t('prefs.vault.idTitle', { id: ownerId }) : undefined} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 13px', borderRadius: 12, border: '1px solid var(--line)', background: 'var(--paper)', marginBottom: 8 }}>
        <div style={{ width: 34, height: 34, borderRadius: 999, flexShrink: 0, background: 'linear-gradient(145deg, var(--accent), var(--accent-ink))', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontFamily: 'var(--serif)', fontSize: 16, fontWeight: 600 }}>V</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            {ownerId && (
              <span style={{ fontFamily: 'var(--ui)', fontSize: 9.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--ink-3)' }}>{t('prefs.vault.idLabel')}</span>
            )}
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5, fontWeight: 600, color: 'var(--ink)', wordBreak: 'break-all' }}>
              {ownerId ?? t('prefs.vault.yourVault')}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
            <ConnectionDot status={status} size={7} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>{connLabel(status).toLowerCase()}</span>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Row icon="lock" label={t('prefs.vault.lock')} onClick={handOff(onLock)} />
        <RelayServerRow />
        <Row icon="key" label={t('prefs.vault.deviceUnlock')} value={vaultMethod === 'securityKey' ? t('prefs.vault.method.securityKey') : vaultMethod === 'passphrase' ? t('prefs.vault.method.passphrase') : t('common.off')} onClick={handOff(onDeviceUnlock)} />
        <Row icon="shield" label={t('prefs.vault.rotate')} onClick={handOff(onRotate)} />
      </div>
      {/* Data in/out — its own section (export will join import here). */}
      <SectionLabel>{t('prefs.vault.data')}</SectionLabel>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Row icon="download" label={t('prefs.vault.import')} onClick={handOff(onImport)} />
      </div>
      {/* Destructive action set apart from the routine vault rows. */}
      <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
        <Row icon="trash" label={t('prefs.vault.delete')} danger onClick={handOff(onDeleteVault)} />
      </div>
    </div>
  );

  const info = (
    <div>
      <SectionLabel first>{t('prefs.info.section')}</SectionLabel>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 13px', borderRadius: 12, border: '1px solid var(--line)', background: 'var(--paper)', marginBottom: 8 }}>
        <svg width="30" height="30" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
          <circle cx="12" cy="12" r="9.5" fill="none" stroke="var(--accent)" strokeWidth="1.5" />
          <circle cx="12" cy="12" r="3.4" fill="var(--accent)" />
          <circle cx="12" cy="12" r="9.5" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="2 3.2" opacity="0.4" />
        </svg>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 16, fontWeight: 500, color: 'var(--ink)' }}>Mneme</div>
          <div style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--ink-3)', marginTop: 1 }}>{t('prefs.info.tagline')}</div>
        </div>
      </div>
      <div style={{ border: '1px solid var(--line)', borderRadius: 12, background: 'var(--paper)', overflow: 'hidden' }}>
        <InfoRow label={t('prefs.info.version')} value={`v${APP_VERSION}`} />
        <InfoRow label={t('prefs.info.built')} value={buildTimeLabel()} last />
      </div>
      <p style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--ink-3)', margin: '12px 2px 0', lineHeight: 1.5 }}>
        {t('prefs.info.footer')}
      </p>
    </div>
  );

  const panes: Record<TabId, VNode> = { appearance, writing, assistant, vault, info };

  // Desktop: a left nav rail beside the content pane. Mobile: a segmented tab
  // bar above it. The header + tabs stay fixed; only the pane scrolls.
  const rail = (
    <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, width: 158, flexShrink: 0, paddingInlineEnd: 14, borderInlineEnd: '1px solid var(--line)' }}>
      {TABS.map((tb) => {
        const active = tab === tb.id;
        return (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'start', cursor: 'pointer', padding: '10px 12px', borderRadius: 10, border: 'none', background: active ? 'var(--accent-soft)' : 'transparent', color: active ? 'var(--accent-ink)' : 'var(--ink-2)', fontFamily: 'var(--ui)', fontSize: 13, fontWeight: active ? 700 : 600 }}
          >
            <Icon name={tb.icon} size={16} color={active ? 'var(--accent)' : 'var(--ink-3)'} />
            {/* Ids mirror the 'prefs.tab.*' catalog entries. */}
            {t(`prefs.tab.${tb.id}` as MessageKey)}
          </button>
        );
      })}
    </nav>
  );

  const segmented = (
    <div style={{ display: 'flex', gap: 4, background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 13, padding: 4, marginBottom: 14 }}>
      {TABS.map((tb) => {
        const active = tab === tb.id;
        return (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '8px 0 6px', borderRadius: 9, cursor: 'pointer', border: 'none', background: active ? 'var(--surface)' : 'transparent', boxShadow: active ? '0 1px 3px rgba(30,20,12,.12)' : 'none', color: active ? 'var(--accent-ink)' : 'var(--ink-3)', fontFamily: 'var(--ui)', fontSize: 10.5, fontWeight: active ? 700 : 600 }}
          >
            <Icon name={tb.icon} size={16} color={active ? 'var(--accent)' : 'var(--ink-3)'} />
            {t(`prefs.tab.${tb.id}.short` as MessageKey)}
          </button>
        );
      })}
    </div>
  );

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexShrink: 0 }}>
      <h3 style={{ fontFamily: 'var(--serif)', fontSize: 20, fontWeight: 500, color: 'var(--ink)', margin: 0 }}>{t('prefs.title')}</h3>
      {desk && (
        <button onClick={onClose} title={t('common.close')} style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="x" size={17} color="var(--ink-3)" />
        </button>
      )}
    </div>
  );

  const card = desk ? (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ width: 620, maxWidth: '100%', height: 'min(560px, 86vh)', boxSizing: 'border-box', background: 'var(--surface)', borderRadius: 20, border: '1px solid var(--line)', padding: '22px 24px 24px', boxShadow: '0 20px 60px rgba(30,20,12,.3)', display: 'flex', flexDirection: 'column' }}
    >
      {header}
      <div style={{ display: 'flex', gap: 20, flex: 1, minHeight: 0 }}>
        {rail}
        <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', paddingInlineEnd: 4 }}>{panes[tab]}</div>
      </div>
    </div>
  ) : (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ width: '100%', maxHeight: '88vh', boxSizing: 'border-box', background: 'var(--surface)', borderRadius: '24px 24px 0 0', border: '1px solid var(--line)', padding: '14px 22px calc(env(safe-area-inset-bottom, 0px) + 26px)', boxShadow: '0 -20px 60px rgba(30,20,12,.25)', display: 'flex', flexDirection: 'column' }}
    >
      <SheetGrabber style={{ margin: '0 auto 14px', flexShrink: 0 }} />
      {header}
      {segmented}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{panes[tab]}</div>
    </div>
  );

  return (
    <SheetBackdrop role="dialog" onClose={onClose} zIndex={Z.overlay} dim="strong" align={desk ? 'center' : 'bottom'} pad={desk ? 18 : 0}>
      {card}
    </SheetBackdrop>
  );
}
