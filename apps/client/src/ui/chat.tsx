// Shared streaming-chat surface pieces for the two assistant conversations
// (Ask my journal, guided interview). The token reducer, the bubble styling,
// and the desk-panel / mobile-keyboard-pinned shell were byte-identical copies
// in both files; the flows on top (free Q&A vs. phased interview + synthesis)
// stay with their owners.
import type { JSX, VNode, ComponentChildren, RefObject } from 'preact';
import { Icon, type IconName } from './Icon';
import { SheetBackdrop, SheetGrabber } from './Sheet';
import { ProviderBadge } from './ProviderBadge';
import type { AiMessage, AiProvider } from '../ai/types';
import type { useVisualViewport } from '../hooks/useVisualViewport';
import { t } from '../i18n';

export const chatPStyle: JSX.CSSProperties = { fontFamily: 'var(--ui)', fontSize: 13, lineHeight: 1.55, color: 'var(--ink-2)', margin: 0 };

/** Append a streamed token to the last (assistant) bubble. */
export function appendToken(prev: AiMessage[], tok: string): AiMessage[] {
  const next = [...prev];
  const last = next[next.length - 1];
  next[next.length - 1] = { ...last, content: last.content + tok };
  return next;
}

/** Drop an empty assistant bubble after a failed send; keep any partial text. */
export function dropEmptyTail(prev: AiMessage[]): AiMessage[] {
  return prev[prev.length - 1]?.content === '' ? prev.slice(0, -1) : prev;
}

/** The transcript bubbles; the busy tail renders "…" while tokens stream in. */
export function ChatBubbles({ turns, busy }: { turns: AiMessage[]; busy: boolean }): VNode {
  return (
    <>
      {turns.map((m, i) => (
        <div
          key={i}
          style={{
            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '85%', padding: '10px 14px', borderRadius: 14,
            background: m.role === 'user' ? 'var(--accent-soft)' : 'var(--paper)',
            border: `1px solid ${m.role === 'user' ? 'var(--accent-line)' : 'var(--line)'}`,
            fontFamily: m.role === 'user' ? 'var(--ui)' : 'var(--serif)',
            fontSize: m.role === 'user' ? 13.5 : 15,
            lineHeight: 1.6, color: 'var(--ink)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
          }}
        >
          {m.content || (busy && i === turns.length - 1 ? '…' : '')}
        </div>
      ))}
    </>
  );
}

/**
 * The conversation shell. Desktop: an inline, non-modal side panel — rendered
 * as a flex sibling of the main content (app.tsx), so the rest of the app
 * stays usable while the conversation is open. Mobile: a bottom sheet sized to
 * the visual viewport, so the input pins above the keyboard and the transcript
 * scrolls within (a messenger-like layout).
 */
export function AssistantPanel({ desk, icon, title, provider, onClose, vp, panelRef, children }: {
  desk: boolean;
  icon: IconName;
  title: string;
  provider: AiProvider;
  onClose: () => void;
  vp: ReturnType<typeof useVisualViewport>;
  /** Measured by callers that size content to the panel (textarea caps). */
  panelRef?: RefObject<HTMLDivElement>;
  children: ComponentChildren;
}): VNode {
  const panel = (
    <div
      ref={panelRef}
      onClick={(e) => e.stopPropagation()}
      style={{ width: desk ? 'min(440px, 40vw)' : '100%', flexShrink: 0, height: desk ? '100%' : '88%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', background: 'var(--surface)', borderRadius: desk ? 0 : '24px 24px 0 0', border: desk ? 'none' : '1px solid var(--line)', borderInlineStart: '1px solid var(--line)', boxShadow: desk ? 'none' : '0 20px 60px rgba(30,20,12,.3)', overflow: 'hidden' }}
    >
      <div style={{ padding: desk ? '18px 22px 12px' : '14px 20px 10px', borderBottom: '1px solid var(--line)' }}>
        {!desk && <SheetGrabber style={{ margin: '0 auto 12px' }} />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <Icon name={icon} size={17} color="var(--accent)" />
          <h3 style={{ fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 500, color: 'var(--ink)', margin: 0, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</h3>
          <ProviderBadge provider={provider} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--ink-3)' }} aria-label={t('common.close')}>
            <Icon name="x" size={16} />
          </button>
        </div>
      </div>
      {children}
    </div>
  );
  if (desk) return panel;
  return (
    <SheetBackdrop onClose={onClose} align="bottom" style={{ top: vp.offsetTop, height: vp.height, bottom: 'auto' }}>
      {panel}
    </SheetBackdrop>
  );
}
