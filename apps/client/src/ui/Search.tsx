// Vault-wide search, opened from the navigation (desktop sidebar field,
// mobile bottom-nav Search, the Journals-screen search bar, or ⌘/Ctrl+K).
// Everything is matched client-side over the decrypted in-memory entries —
// the relay only ever holds ciphertext, so there is nothing to query remotely.
// A query matches on title, body content, label names, and the entry date
// (written out in several common formats, so "jun 9", "2026-06-09" or
// "9.6.2026" all hit).
import type { VNode } from 'preact';
import { useMemo, useRef, useState } from 'preact/hooks';
import { Icon } from './Icon';
import { LabelChip } from './primitives';
import { SheetBackdrop, Z } from './Sheet';
import { useAppData } from '../state/data';
import { search, normalize, type Hit } from '../search/core';
import { t, monthName, fmtDate, type MessageKey } from '../i18n';

/** Render text with the query tokens emphasized. */
function Highlight({ text, tokens }: { text: string; tokens: string[] }): VNode {
  if (tokens.length === 0) return <>{text}</>;
  const pattern = tokens.map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const parts = text.split(new RegExp(`(${pattern})`, 'gi'));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1
          ? <span key={i} style={{ color: 'var(--accent-ink)', background: 'var(--accent-soft)', borderRadius: 3 }}>{p}</span>
          : p,
      )}
    </>
  );
}

function shortDate(ts: number): string {
  return fmtDate(ts, { day: 'numeric', month: 'short', year: 'numeric' });
}

// Explicit English fallback so date search keeps working regardless of the UI
// language (search/core spells its date haystack in English).
const EN_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// Rewrite month words in the query — written in the active locale's spelling
// (long or short) or in English — to their English long name, so the English
// date haystack search/core builds still matches. Returns null when the query
// carries no month word, so "märz 9" or "9 giu" reach the same entries as "jun 9".
function toEnglishMonths(q: string): string | null {
  const out = q.split(' ').map((tok) => {
    const c = tok.replace(/\.$/, '');
    if (c.length < 3) return tok;
    for (let i = 0; i < 12; i++) {
      const forms = [monthName(i, 'long'), monthName(i, 'short'), EN_MONTHS[i]].map((f) =>
        f.toLowerCase().replace(/\.$/, ''),
      );
      if (forms.some((f) => f === c || f.startsWith(c))) return EN_MONTHS[i];
    }
    return tok;
  });
  const joined = out.join(' ');
  return joined === q ? null : joined;
}

export function SearchSheet({ desk, onClose, onOpen }: {
  desk: boolean;
  onClose: () => void;
  onOpen: (entryId: string) => void;
}): VNode {
  const { entries, journals } = useAppData();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const tokens = normalize(query).split(' ').filter(Boolean);
  const hits = useMemo(() => {
    if (tokens.length > 0) {
      // Match on the query as typed (title/content/labels + English dates), then
      // union in a month-translated pass so locale month spellings hit dates too.
      const base = search(entries, query);
      const alt = toEnglishMonths(normalize(query));
      if (!alt) return base;
      const seen = new Set(base.map((h) => h.entry.id));
      return [...base, ...search(entries, alt).filter((h) => !seen.has(h.entry.id))];
    }
    // Empty query: offer the most recently touched entries as a starting point.
    return [...entries]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8)
      .map((e): Hit => ({ entry: e, field: 'content' }));
  }, [entries, query]);
  const active = Math.min(index, Math.max(0, hits.length - 1));

  const pick = (h: Hit | undefined): void => {
    if (h) onOpen(h.entry.id);
  };
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      onClose();
    } else if (ev.key === 'ArrowDown' && hits.length > 0) {
      ev.preventDefault();
      setIndex((active + 1) % hits.length);
    } else if (ev.key === 'ArrowUp' && hits.length > 0) {
      ev.preventDefault();
      setIndex((active - 1 + hits.length) % hits.length);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      pick(hits[active]);
    }
  };

  const rows = (
    <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: 6, display: 'flex', flexDirection: 'column', gap: 1 }}>
      {hits.length === 0 && (
        <div style={{ padding: '28px 16px', textAlign: 'center', fontFamily: 'var(--ui)', fontSize: 13, color: 'var(--ink-3)' }}>
          {t('shell.search.empty', { query })}
        </div>
      )}
      {hits.map((h, i) => {
        const j = journals.find((x) => x.id === h.entry.journalId);
        const hot = i === active;
        return (
          <button
            key={h.entry.id}
            // mousedown + preventDefault keeps focus in the input (no blur flicker).
            onMouseDown={(ev) => { ev.preventDefault(); pick(h); }}
            onMouseEnter={() => setIndex(i)}
            ref={(el) => { if (hot) el?.scrollIntoView({ block: 'nearest' }); }}
            style={{
              display: 'block', width: '100%', textAlign: 'start', cursor: 'pointer',
              padding: '10px 12px', borderRadius: 12, border: 'none',
              background: hot ? 'var(--accent-soft)' : 'transparent',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: 9, background: j?.color ?? 'var(--ink-3)', flexShrink: 0, alignSelf: 'center' }} />
              <span style={{ flex: 1, fontFamily: 'var(--serif)', fontSize: 15.5, fontWeight: 500, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <Highlight text={h.entry.title || t('common.untitled')} tokens={tokens} />
              </span>
              {h.field !== 'content' && tokens.length > 0 && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--ink-3)', border: '1px solid var(--line)', borderRadius: 6, padding: '1px 6px', flexShrink: 0 }}>
                  {t(`shell.search.field.${h.field}` as MessageKey)}
                </span>
              )}
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', flexShrink: 0 }}>
                <Highlight text={shortDate(h.entry.createdAt)} tokens={tokens} />
              </span>
            </div>
            {h.snippet ? (
              <p style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--ink-2)', margin: '4px 0 0', marginInlineStart: 16, lineHeight: 1.45, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                <Highlight text={h.snippet} tokens={tokens} />
              </p>
            ) : (
              h.entry.bodyText && (
                <p style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--ink-2)', margin: '4px 0 0', marginInlineStart: 16, lineHeight: 1.45, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {h.entry.bodyText}
                </p>
              )
            )}
            {h.field === 'label' && h.entry.labels.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0 0', marginInlineStart: 16 }}>
                {h.entry.labels.map((l) => <LabelChip key={l} id={l} size="sm" />)}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );

  const inputRow = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px', borderBottom: '1px solid var(--line)' }}>
      <Icon name="search" size={18} color="var(--ink-3)" />
      <input
        ref={(el) => el?.focus()}
        value={query}
        onInput={(ev) => { setQuery((ev.target as HTMLInputElement).value); setIndex(0); }}
        onKeyDown={onKeyDown}
        placeholder={t('shell.search.placeholder')}
        style={{
          flex: 1, border: 'none', outline: 'none', background: 'transparent',
          fontFamily: 'var(--ui)', fontSize: 15, color: 'var(--ink)', padding: 0,
        }}
      />
      {desk ? (
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', border: '1px solid var(--line)', borderRadius: 6, padding: '2px 6px' }}>esc</span>
      ) : (
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 4, display: 'flex' }}>
          <Icon name="x" size={20} color="var(--ink-2)" />
        </button>
      )}
    </div>
  );

  if (desk) {
    return (
      <SheetBackdrop onClose={onClose} zIndex={Z.overlay} align="top">
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            width: 620, maxWidth: 'calc(100vw - 48px)', marginTop: '11vh', maxHeight: '64vh',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 18,
            boxShadow: '0 24px 70px rgba(30,20,12,.32)',
          }}
        >
          {inputRow}
          {rows}
        </div>
      </SheetBackdrop>
    );
  }

  // Mobile: a full-height sheet so the keyboard and results share the screen.
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: Z.overlay, background: 'var(--paper)', display: 'flex', flexDirection: 'column', paddingTop: 'env(safe-area-inset-top, 0px)' }}>
      {inputRow}
      {rows}
    </div>
  );
}
