// The entry-header label row: existing chips (removable) plus a "+ label"
// affordance that opens an inline text field with autocomplete over the
// labels already used across the journal. Enter on an unmatched name creates
// a brand-new label — labels are free-form strings inside the encrypted
// entry body, so no registry exists beyond "what entries already carry".
import type { VNode } from 'preact';
import { useMemo, useRef, useState } from 'preact/hooks';
import { Icon } from './Icon';
import { LabelChip } from './primitives';
import { Z } from './Sheet';
import { labelInfo } from '../data/sample';
import { hexA } from './color';
import { t } from '../i18n';

const MENU_W = 220;
const MENU_MAX_H = 240;

/** Labels are matched and stored case-insensitively, single-spaced. */
function normalize(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function LabelField({
  labels,
  suggestions,
  onChange,
}: {
  labels: string[];
  /** Candidate labels (already used elsewhere), best-first. */
  suggestions: string[];
  onChange: (labels: string[]) => void;
}): VNode {
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = normalize(query);
  const matches = useMemo(
    () => suggestions.filter((s) => !labels.includes(s) && (!q || s.includes(q))),
    [suggestions, labels, q],
  );
  // Typing a name nobody has used yet offers a "create" row at the bottom.
  const creatable = q !== '' && !labels.includes(q) && !suggestions.includes(q);
  const optionCount = matches.length + (creatable ? 1 : 0);
  const active = Math.min(index, Math.max(0, optionCount - 1));

  const add = (label: string): void => {
    onChange([...labels, label]);
    setQuery('');
    setIndex(0);
    inputRef.current?.focus();
  };
  const remove = (label: string): void => {
    onChange(labels.filter((l) => l !== label));
  };
  const close = (): void => {
    setEditing(false);
    setQuery('');
    setIndex(0);
  };
  const pick = (i: number): void => {
    if (i < matches.length) add(matches[i]);
    else if (creatable) add(q);
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
    } else if (ev.key === 'ArrowDown' && optionCount > 0) {
      ev.preventDefault();
      setIndex((active + 1) % optionCount);
    } else if (ev.key === 'ArrowUp' && optionCount > 0) {
      ev.preventDefault();
      setIndex((active - 1 + optionCount) % optionCount);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      pick(active);
    } else if (ev.key === 'Backspace' && query === '' && labels.length > 0) {
      remove(labels[labels.length - 1]);
    }
  };

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      {labels.map((l) => <LabelChip key={l} id={l} onRemove={() => remove(l)} />)}

      {!editing && (
        <button
          onClick={() => setEditing(true)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 600, color: 'var(--ink-3)',
            background: 'transparent', border: '1px dashed var(--line)', borderRadius: 999,
            padding: '3px 9px', cursor: 'pointer',
          }}
        >
          <Icon name="plus" size={13} /> {t('editor.labels.add')}
        </button>
      )}

      {editing && (
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          <input
            ref={(el) => { inputRef.current = el; el?.focus(); }}
            value={query}
            onInput={(ev) => { setQuery((ev.target as HTMLInputElement).value); setIndex(0); }}
            onKeyDown={onKeyDown}
            onBlur={close}
            placeholder={t('editor.labels.placeholder')}
            style={{
              width: 110, fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 600,
              color: 'var(--ink)', background: 'var(--surface)',
              border: '1px dashed var(--accent-line)', borderRadius: 999,
              padding: '3px 10px', outline: 'none',
            }}
          />
          {optionCount > 0 && (
            <div
              style={{
                position: 'absolute', zIndex: Z.sheet, top: 'calc(100% + 6px)', insetInlineStart: 0,
                width: MENU_W, maxHeight: MENU_MAX_H, overflowY: 'auto', padding: 5,
                background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14,
                boxShadow: '0 10px 30px rgba(40,28,18,.18)',
              }}
            >
              {matches.map((s, i) => {
                const L = labelInfo(s);
                const hot = i === active;
                return (
                  <button
                    key={s}
                    // mousedown + preventDefault keeps focus in the input (no blur-close race).
                    onMouseDown={(ev) => { ev.preventDefault(); add(s); }}
                    onMouseEnter={() => setIndex(i)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'start',
                      padding: '6px 9px', borderRadius: 10, border: 'none', cursor: 'pointer',
                      background: hot ? 'var(--accent-soft)' : 'transparent',
                      fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600,
                      color: hot ? 'var(--accent-ink)' : 'var(--ink)',
                    }}
                  >
                    <span style={{ width: 7, height: 7, borderRadius: 9, flexShrink: 0, background: L.color, boxShadow: `0 0 0 3px ${hexA(L.color, 0.15)}` }} />
                    {L.name}
                  </button>
                );
              })}
              {creatable && (
                <button
                  onMouseDown={(ev) => { ev.preventDefault(); add(q); }}
                  onMouseEnter={() => setIndex(matches.length)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'start',
                    padding: '6px 9px', borderRadius: 10, border: 'none', cursor: 'pointer',
                    background: active === matches.length ? 'var(--accent-soft)' : 'transparent',
                    fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600,
                    color: active === matches.length ? 'var(--accent-ink)' : 'var(--ink-2)',
                  }}
                >
                  <Icon name="plus" size={13} />
                  {t('editor.labels.create', { name: q })}
                </button>
              )}
            </div>
          )}
        </span>
      )}
    </div>
  );
}
