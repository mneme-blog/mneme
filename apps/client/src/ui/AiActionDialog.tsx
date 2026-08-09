// Editor writing-assistant dialog: runs one action (continue / summarize /
// suggest title) over the *current entry only*, streams the result into a
// read-only preview, and touches nothing until the user confirms. Insert goes
// through the editor's normal insert-at-cursor path; titles go through the
// caller (which routes them into the entry's autosave).
import type { JSX, VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './Icon';
import { Btn } from './primitives';
import { Sheet, Z } from './Sheet';
import { t, type MessageKey } from '../i18n';
import { ProviderBadge } from './ProviderBadge';
import { makeProvider } from '../ai/provider';
import { editorSystemPrompt, editorUserMessage, type AiEditorAction } from '../ai/prompts';
import { toAiError, type AiSettings } from '../ai/types';
import { chatErrorMessage } from '../ai/errors';

// Message keys (not the translated strings) — resolved with t() at render time.
const TITLE_KEYS: Record<AiEditorAction, MessageKey> = {
  continue: 'assistant.action.continue',
  summarize: 'assistant.action.summarize',
  title: 'assistant.action.title',
};

const pStyle: JSX.CSSProperties = { fontFamily: 'var(--ui)', fontSize: 13, lineHeight: 1.55, color: 'var(--ink-2)', margin: 0 };

export function AiActionDialog({ action, entryTitle, entryText, settings, onInsert, onPickTitle, onClose }: {
  action: AiEditorAction;
  entryTitle: string;
  entryText: string;
  settings: AiSettings;
  /** Confirmed: insert the generated text at the cursor. */
  onInsert: (text: string) => void;
  /** Confirmed (title action): apply the picked title. */
  onPickTitle: (title: string) => void;
  onClose: () => void;
}): VNode {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const provider = useRef(makeProvider(settings)).current;

  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setError('');
    setText('');
    void provider
      .chat({
        system: editorSystemPrompt(action, entryTitle, entryText),
        messages: [{ role: 'user', content: editorUserMessage(action) }],
        maxTokens: 1024,
        signal: ac.signal,
        onToken: (tok) => setText((prev) => prev + tok),
      })
      .catch((e: unknown) => {
        const err = toAiError(e);
        if (err.hint !== 'aborted') {
          setError(chatErrorMessage(err, provider.local, 'assistant.error.refused'));
        }
      })
      .finally(() => setBusy(false));
    return () => ac.abort();
    // Run exactly once per dialog open; the action/entry are fixed at open time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const titleOptions = action === 'title' && !busy && !error
    ? text.split('\n').map((l) => l.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean).slice(0, 3)
    : [];

  return (
    <Sheet
      center
      onClose={onClose}
      zIndex={Z.overlay}
      pad={16}
      width={520}
      cardStyle={{ borderRadius: 18, maxHeight: '85%', display: 'flex', flexDirection: 'column', gap: 13 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <Icon name="feather" size={16} color="var(--accent)" />
        <h3 style={{ fontFamily: 'var(--serif)', fontSize: 17, fontWeight: 500, color: 'var(--ink)', margin: 0, flex: 1 }}>{t(TITLE_KEYS[action])}</h3>
        <ProviderBadge provider={provider} />
      </div>

      {error ? (
        <p style={{ ...pStyle, color: 'var(--accent-ink)' }}>{error}</p>
      ) : titleOptions.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p style={pStyle}>{t('assistant.action.pickTitle')}</p>
          {titleOptions.map((opt) => (
            <button
              key={opt}
              onClick={() => { onPickTitle(opt); onClose(); }}
              style={{ fontFamily: 'var(--serif)', fontSize: 15.5, color: 'var(--ink)', textAlign: 'start', padding: '11px 14px', borderRadius: 12, background: 'var(--paper)', border: '1px solid var(--line)', cursor: 'pointer' }}
            >
              {opt}
            </button>
          ))}
        </div>
      ) : (
        <div style={{ overflowY: 'auto', minHeight: 90, padding: '12px 14px', borderRadius: 12, background: 'var(--paper)', border: '1px solid var(--line)', fontFamily: 'var(--serif)', fontSize: 15, lineHeight: 1.65, color: 'var(--ink)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {text || <span style={{ color: 'var(--ink-3)' }}>{busy ? t('assistant.action.thinking') : t('assistant.action.nothing')}</span>}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10 }}>
        {busy ? (
          <>
            <Btn kind="ghost" size="md" onClick={() => abortRef.current?.abort()} style={{ flex: 1 }}>{t('assistant.stop')}</Btn>
            <Btn kind="ghost" size="md" onClick={onClose} style={{ flex: 1 }}>{t('common.cancel')}</Btn>
          </>
        ) : (
          <>
            <Btn kind="ghost" size="md" onClick={onClose} style={{ flex: 1 }}>{t('assistant.discard')}</Btn>
            {action !== 'title' && text && !error && (
              <Btn kind="primary" size="md" onClick={() => { onInsert(text); onClose(); }} style={{ flex: 2 }}>{t('assistant.action.insert')}</Btn>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
