// The popup half of the slash command palette (see slash.ts for the plugin
// half). Renders fixed-position next to the caret, navigable by arrows/Enter
// or mouse; Escape dismisses without eating the typed "/".
import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '../ui/Icon';
import { Z } from '../ui/Sheet';
import type { SlashHandle, SlashMenuState } from './slash';

const MENU_W = 252;
const MENU_MAX_H = 288;
const GAP = 6;

export function SlashMenu({ handle }: { handle: SlashHandle }): VNode | null {
  const [state, setState] = useState<SlashMenuState | null>(null);
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // The keydown listener is registered once; refs keep it reading live values.
  const stateRef = useRef(state);
  stateRef.current = state;
  const indexRef = useRef(index);
  indexRef.current = index;

  useEffect(() => {
    handle.listener = {
      show: (s) => {
        // Fresh open starts at the top; refinement keeps (clamped) position.
        if (stateRef.current) setIndex((i) => Math.min(i, Math.max(0, s.items.length - 1)));
        else setIndex(0);
        setState(s);
      },
      hide: () => setState(null),
      keydown: (event) => {
        const s = stateRef.current;
        if (!s) return false;
        if (event.key === 'Escape') {
          s.dismiss();
          return true;
        }
        const len = s.items.length;
        if (len === 0) return false;
        if (event.key === 'ArrowDown') {
          setIndex((indexRef.current + 1) % len);
          return true;
        }
        if (event.key === 'ArrowUp') {
          setIndex((indexRef.current - 1 + len) % len);
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const item = s.items[indexRef.current];
          if (item) s.select(item);
          return true;
        }
        return false;
      },
    };
    return () => {
      handle.listener = null;
    };
  }, [handle]);

  useEffect(() => {
    listRef.current?.children[index]?.scrollIntoView({ block: 'nearest' });
  }, [index, state]);

  if (!state || state.items.length === 0) return null;
  const rect = state.clientRect?.();
  if (!rect) return null;

  const left = Math.max(8, Math.min(rect.left, window.innerWidth - MENU_W - 8));
  const fitsBelow = rect.bottom + GAP + MENU_MAX_H < window.innerHeight - 8;

  return (
    <div
      ref={listRef}
      style={{
        position: 'fixed', zIndex: Z.dialog, width: MENU_W, left,
        ...(fitsBelow
          ? { top: rect.bottom + GAP }
          : { top: Math.max(8, rect.top - GAP), transform: 'translateY(-100%)' }),
        maxHeight: MENU_MAX_H, overflowY: 'auto', padding: 5,
        background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14,
        boxShadow: '0 10px 30px rgba(40,28,18,.18)',
      }}
    >
      {state.items.map((item, i) => {
        const active = i === index;
        return (
          <button
            key={item.title}
            onMouseDown={(ev) => {
              // Keep the editor selection — don't let the button steal focus.
              ev.preventDefault();
              state.select(item);
            }}
            onMouseEnter={() => setIndex(i)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'start',
              padding: '7px 9px', borderRadius: 10, border: 'none', cursor: 'pointer',
              background: active ? 'var(--accent-soft)' : 'transparent',
            }}
          >
            <span style={{
              width: 30, height: 30, borderRadius: 8, flexShrink: 0,
              border: '1px solid var(--line)', background: 'var(--surface-2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: active ? 'var(--accent-ink)' : 'var(--ink-2)',
            }}>
              <Icon name={item.icon} size={16} />
            </span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontFamily: 'var(--ui)', fontSize: 13.5, fontWeight: 600, color: active ? 'var(--accent-ink)' : 'var(--ink)' }}>
                {item.title}
              </span>
              <span style={{ display: 'block', fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--ink-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {item.hint}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
