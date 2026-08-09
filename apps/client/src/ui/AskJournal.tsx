// "Ask my journal" — Q&A over the decrypted in-memory entries. Each question
// rebuilds the excerpt context (search-ranked + recency, ai/context.ts) and is
// answered by the configured provider, streaming. The transcript lives in
// component state only: closing the sheet (or locking) drops it; nothing about
// the conversation is ever persisted or synced.
import type { VNode } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Btn } from './primitives';
import { AssistantPanel, ChatBubbles, appendToken, dropEmptyTail, chatPStyle as pStyle } from './chat';
import { useVisualViewport } from '../hooks/useVisualViewport';
import { t, tp } from '../i18n';
import { useAppData } from '../state/data';
import { makeProvider } from '../ai/provider';
import { buildJournalContext, CLOUD_BUDGET_CHARS, LOCAL_BUDGET_CHARS } from '../ai/context';
import { chatSystemPrompt } from '../ai/prompts';
import { toAiError, type AiMessage } from '../ai/types';
import { chatErrorMessage } from '../ai/errors';

export function AskJournalSheet({ desk, onClose }: { desk: boolean; onClose: () => void }): VNode | null {
  const { entries, aiSettings } = useAppData();
  const [transcript, setTranscript] = useState<AiMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Kept as data (not a prebuilt string) so the note re-translates on locale change.
  const [contextNote, setContextNote] = useState<{ count: number; truncated: boolean } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const provider = useMemo(() => (aiSettings?.enabled ? makeProvider(aiSettings) : null), [aiSettings]);
  // Size the mobile sheet to the visible area so the input stays above the
  // keyboard (see useVisualViewport) instead of being pushed off-screen.
  const vp = useVisualViewport();

  useEffect(() => {
    inputRef.current?.focus();
    // Stop a stream that's still running when the sheet goes away.
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
    // vp.height is a dep so opening the keyboard keeps the latest answer in view.
  }, [transcript, vp.height]);

  if (!provider || !aiSettings) return null;

  const send = async (): Promise<void> => {
    const q = input.trim();
    if (!q || busy) return;
    const ctx = buildJournalContext(entries, q, provider.local ? LOCAL_BUDGET_CHARS : CLOUD_BUDGET_CHARS);
    setContextNote({ count: ctx.entryCount, truncated: ctx.truncated });
    const history: AiMessage[] = [...transcript, { role: 'user', content: q }];
    setTranscript([...history, { role: 'assistant', content: '' }]);
    setInput('');
    setError('');
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await provider.chat({
        system: chatSystemPrompt(ctx.text, ctx.fenceToken),
        messages: history,
        signal: ac.signal,
        onToken: (tok) => setTranscript((prev) => appendToken(prev, tok)),
      });
    } catch (e) {
      const err = toAiError(e);
      if (err.hint !== 'aborted') {
        setError(chatErrorMessage(err, provider.local, 'assistant.error.refusedAnswer'));
        setTranscript(dropEmptyTail);
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  return (
    <AssistantPanel desk={desk} icon="feather" title={t('assistant.ask.title')} provider={provider} onClose={onClose} vp={vp}>
        <div ref={logRef} style={{ flex: 1, overflowY: 'auto', padding: desk ? '16px 22px' : '14px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {transcript.length === 0 && (
            <div style={{ margin: 'auto', textAlign: 'center', maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <p style={{ ...pStyle, fontSize: 14, color: 'var(--ink-2)' }}>
                {t('assistant.ask.emptyHint')}
              </p>
              <p style={{ ...pStyle, fontSize: 11.5, color: 'var(--ink-3)' }}>
                {t('assistant.ask.notSaved')}
              </p>
            </div>
          )}
          <ChatBubbles turns={transcript} busy={busy} />
          {error && <p style={{ ...pStyle, color: 'var(--accent-ink)' }}>{error}</p>}
        </div>

        <div style={{ borderTop: '1px solid var(--line)', padding: desk ? '12px 22px 16px' : '10px 18px 18px' }}>
          {contextNote && (
            <div style={{ fontFamily: 'var(--ui)', fontSize: 11, color: 'var(--ink-3)', marginBottom: 7 }}>
              {tp(contextNote.truncated ? 'assistant.ask.contextTruncated' : 'assistant.ask.context', contextNote.count)}
            </div>
          )}
          <form onSubmit={(e) => { e.preventDefault(); void send(); }} style={{ display: 'flex', gap: 9 }}>
            <input
              ref={inputRef}
              value={input}
              onInput={(e) => setInput((e.target as HTMLInputElement).value)}
              placeholder={t('assistant.ask.placeholder')}
              style={{ flex: 1, fontFamily: 'var(--ui)', fontSize: 14, color: 'var(--ink)', padding: '11px 14px', borderRadius: 12, background: 'var(--paper)', border: '1px solid var(--line)', outline: 'none' }}
            />
            {busy ? (
              <Btn kind="ghost" size="md" onClick={() => abortRef.current?.abort()}>{t('assistant.stop')}</Btn>
            ) : (
              <Btn kind="primary" size="md" type="submit" style={{ opacity: input.trim() ? 1 : 0.55 }}>{t('assistant.ask.send')}</Btn>
            )}
          </form>
        </div>
    </AssistantPanel>
  );
}
