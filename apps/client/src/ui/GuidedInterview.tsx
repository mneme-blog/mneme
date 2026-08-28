// Guided interview — the AI conducts a short Q&A (or a one-line freeform brief),
// then synthesizes a journal entry the user reviews before anything is saved.
//
// It no longer picks anything: the interview type, the notebook, and the
// deeper-questions answer all arrive as props from ui/NewEntryWizard.tsx, which
// is now the single place a new entry begins. This sheet opens straight into
// the first question.
//
// Two AI phases share one streaming path (ai/prompts.ts): the question phase
// (interviewSystemPrompt drives one-question-at-a-time turns, primed with the
// same-type history from ai/interview.ts so it feels continuous) and the
// synthesis phase (interviewSynthesisPrompt rewrites the whole transcript into a
// first-person entry as simple Markdown, led by a "# " title line). On save, the
// title line becomes the entry's title (splitMarkdownTitle — no date-time default)
// and markdownToDoc turns the rest into a real entry tagged with the interview
// type's name — that label is what buildInterviewHistory matches next time. The transcript lives in component
// state only; like Ask-my-journal, nothing about the conversation is persisted
// or synced — only the entry the user chooses to save is.
import type { JSX, VNode } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Btn } from './primitives';
import { AssistantPanel, ChatBubbles, appendToken, dropEmptyTail } from './chat';
import { useVisualViewport } from '../hooks/useVisualViewport';
import { t } from '../i18n';
import { useAppData } from '../state/data';
import type { InterviewType } from '../sync/engine';
import { makeProvider } from '../ai/provider';
import {
  interviewSystemPrompt,
  interviewSynthesisPrompt,
  interviewSynthesisUserMessage,
  freeformDraftPrompt,
  type InterviewDynamics,
} from '../ai/prompts';
import { buildInterviewHistory, HISTORY_BUDGET_CHARS } from '../ai/interview';
import { buildRetrospect, journalGap, RETRO_BUDGET_CHARS } from '../ai/reflection';
import { markdownToDoc, splitMarkdownTitle, docToText } from '../editor/doc';
import { DocPreview } from '../editor/DocPreview';
import { toAiError, type AiMessage } from '../ai/types';
import { chatErrorMessage } from '../ai/errors';

const pStyle: JSX.CSSProperties = { fontFamily: 'var(--ui)', fontSize: 13, lineHeight: 1.55, color: 'var(--ink-2)', margin: 0 };

// The seed turn that makes the model open with its first question (Anthropic
// requires the conversation to start with a user message). Hidden from the UI.
const SEED: AiMessage = { role: 'user', content: 'Please begin the interview with your first question.' };

type Phase = 'interview' | 'brief' | 'review';

export function GuidedInterviewSheet({
  desk,
  onClose,
  onOpenEntry,
  journalId,
  start,
  deep,
}: {
  desk: boolean;
  onClose: () => void;
  /** Open the freshly-saved entry in the editor. */
  onOpenEntry: (id: string) => void;
  /** Notebook the saved entry lands in. Always explicit — the wizard resolves
      it and shows it before the interview starts, so nothing is guessed here. */
  journalId: string;
  /** What to run: an interview type, or the one-line freeform brief. */
  start: InterviewType | 'freeform';
  /** The deeper-questions answer (ai/reflection.ts), decided in the wizard
      immediately before this sheet opened. */
  deep: boolean;
}): VNode | null {
  const { entries, aiSettings, createEntry } = useAppData();
  const [phase, setPhase] = useState<Phase>(start === 'freeform' ? 'brief' : 'interview');
  // The interview type — fixed for the life of the sheet; null for a freeform draft.
  const type: InterviewType | null = start === 'freeform' ? null : start;
  // Full API history including the hidden SEED turn; the UI renders messages.slice(1).
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [input, setInput] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  // What the question phase was last primed with. The synthesis needs to know a
  // look-back question may be sitting in the transcript: its answer reads as a
  // non-sequitur in the finished entry unless the write-up reintroduces the
  // older thought first (ai/prompts.ts interviewSynthesisPrompt).
  const dynRef = useRef<InterviewDynamics>({});
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const provider = useMemo(() => (aiSettings?.enabled ? makeProvider(aiSettings) : null), [aiSettings]);
  // How long the journal has been quiet, when that is long enough to be worth
  // opening with (ai/reflection.ts). Derived from the entries already decrypted
  // in memory — no extra request, and the tone rules that keep the question
  // free of guilt live in the prompt. Computed regardless and gated at the use
  // site, so opting in mid-session needs no recompute.
  const gap = useMemo(() => journalGap(entries), [entries]);
  // Size the mobile sheet to the visible area so the input stays above the
  // keyboard (see useVisualViewport) instead of being pushed off-screen.
  const vp = useVisualViewport();

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
    // vp.height is a dep so opening the keyboard (which shrinks the sheet) keeps
    // the latest question pinned in view right above the answer box.
  }, [messages, phase, vp.height]);
  useEffect(() => {
    if (phase === 'interview' || phase === 'brief') inputRef.current?.focus();
  }, [phase]);
  // Auto-grow the answer/brief box with its content, capped at 65% of the
  // sheet height (measured, so it holds on the desktop side panel and the 88%
  // mobile sheet alike). Runs on every input change — including the reset to
  // '' after sending, which shrinks it back down.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const cap = Math.round((panelRef.current?.clientHeight ?? window.innerHeight) * 0.65);
    const prev = el.style.height;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
    el.style.overflowY = el.scrollHeight > cap ? 'auto' : 'hidden';
    // Growing the box squeezes the transcript above it — keep the latest
    // question in view, but only when the height actually changed so a reader
    // scrolled up isn't yanked back down on every keystroke.
    if (el.style.height !== prev) logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [input, phase]);
  // Ask the first question, once. A freeform draft opens straight into its
  // brief box and needs no turn. Guarded on `provider`: without it the render
  // below bails before askTurn/systemFor exist, and the effect must not touch
  // them then.
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current || !provider || start === 'freeform') return;
    startedRef.current = true;
    void askTurn(systemFor(start, deep), [SEED]);
  });

  if (!provider || !aiSettings) return null;

  const errorText = (e: unknown): string => {
    const err = toAiError(e);
    if (err.hint === 'aborted') return '';
    return chatErrorMessage(err, provider.local, 'assistant.error.refusedRespond');
  };

  // Stream one assistant turn onto `messages` (the interview Q&A). On
  // failure/abort the error is surfaced and the empty assistant bubble dropped.
  const askTurn = async (system: string, history: AiMessage[]): Promise<void> => {
    setMessages([...history, { role: 'assistant', content: '' }]);
    setError('');
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await provider.chat({
        system,
        messages: history,
        maxTokens: 512,
        signal: ac.signal,
        onToken: (tok) => setMessages((prev) => appendToken(prev, tok)),
      });
    } catch (e) {
      const msg = errorText(e);
      if (msg) setError(msg);
      // Keep any partial question; only an empty bubble is dropped.
      setMessages(dropEmptyTail);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  // The system prompt for one turn: the same-type history plus the two dynamics
  // (the gap, and older thoughts worth revisiting). Rebuilt per turn rather than
  // memoized — everything it reads is already in memory, and a long session can
  // see the entries change underneath it. Local backends get half the budget,
  // the same split the history has always used: an 8k context has to hold the
  // transcript too.
  // `on` is passed explicitly rather than read from `deep`, because the first
  // turn runs in the same tick as the consent overlay's setState — the state
  // has not settled yet, and the answer the user just gave must apply now.
  const systemFor = (it: InterviewType, on: boolean = deep): string => {
    const budget = (n: number): number => (provider.local ? Math.round(n / 2) : n);
    const history = buildInterviewHistory(entries, it.name, budget(HISTORY_BUDGET_CHARS));
    const dynamics: InterviewDynamics = on
      ? {
          gap,
          // Entries already in the history block are excluded so one entry can't
          // fill two sections of the same prompt.
          retrospect: buildRetrospect(entries, { excludeIds: history.ids, budgetChars: budget(RETRO_BUDGET_CHARS) }),
        }
      : {};
    // Recorded rather than recomputed at finish time, so the write-up is told
    // about exactly what the questions were primed with.
    dynRef.current = dynamics;
    return interviewSystemPrompt(it, history.text, dynamics);
  };

  const sendAnswer = (): void => {
    const a = input.trim();
    if (!a || busy || !type) return;
    setInput('');
    void askTurn(systemFor(type), [...messages, { role: 'user', content: a }]);
  };

  // Stream the synthesized entry (Markdown) into `draft` and move to review.
  const synthesize = async (system: string, history: AiMessage[]): Promise<void> => {
    setPhase('review');
    setDraft('');
    setError('');
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await provider.chat({
        system,
        messages: history,
        maxTokens: 1536,
        signal: ac.signal,
        onToken: (tok) => setDraft((prev) => prev + tok),
      });
    } catch (e) {
      const msg = errorText(e);
      if (msg) setError(msg);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  // Finish the Q&A → synthesize from the real exchange (drop the hidden SEED).
  const finishInterview = (): void => {
    if (!type) return;
    const qa = messages.slice(1).filter((m) => m.content.trim());
    void synthesize(interviewSynthesisPrompt(type, dynRef.current), [...qa, { role: 'user', content: interviewSynthesisUserMessage() }]);
  };

  const submitBrief = (): void => {
    const brief = input.trim();
    if (!brief || busy) return;
    setInput('');
    void synthesize(freeformDraftPrompt(), [{ role: 'user', content: brief }]);
  };

  const save = (): void => {
    const text = draft.trim();
    if (!text) return;
    // The synthesis prompts ask for a leading "# " title line; lift it into the
    // entry's title (instead of the date-time default) and keep it out of the
    // body. A draft without one falls back to the default title untouched.
    const { title, body } = splitMarkdownTitle(text);
    const doc = markdownToDoc(body);
    const entry = createEntry({
      journalId,
      title: title ?? undefined,
      bodyJson: JSON.stringify(doc),
      bodyText: docToText(doc),
      // Tag with the interview type's name so future runs of the same type can
      // find this entry as history (ai/interview.ts buildInterviewHistory).
      labels: type ? [type.name] : [],
    });
    onOpenEntry(entry.id);
    onClose();
  };

  // The transcript bubbles (interview phase) — SEED hidden.
  const visibleTurns = messages.slice(1);
  const canFinish = type !== null && visibleTurns.some((m) => m.role === 'user') && !busy;

  // ── phase: interview Q&A ──
  const interviewBody = (
    <>
      <div ref={logRef} style={{ flex: 1, overflowY: 'auto', padding: desk ? '16px 22px' : '14px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <ChatBubbles turns={visibleTurns} busy={busy} />
        {error && <p style={{ ...pStyle, color: 'var(--accent-ink)' }}>{error}</p>}
      </div>
      <div style={{ borderTop: '1px solid var(--line)', padding: desk ? '12px 22px 16px' : '10px 18px 18px', display: 'flex', flexDirection: 'column', gap: 9 }}>
        <form onSubmit={(e) => { e.preventDefault(); sendAnswer(); }} style={{ display: 'flex', gap: 9, alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            value={input}
            rows={2}
            onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAnswer(); } }}
            placeholder={t('assistant.interview.answerPlaceholder')}
            style={{ flex: 1, resize: 'none', fontFamily: 'var(--ui)', fontSize: 14, lineHeight: 1.5, color: 'var(--ink)', padding: '11px 14px', borderRadius: 12, background: 'var(--paper)', border: '1px solid var(--line)', outline: 'none' }}
          />
          {busy ? (
            <Btn kind="ghost" size="md" onClick={() => abortRef.current?.abort()}>{t('assistant.stop')}</Btn>
          ) : (
            <Btn kind="primary" size="md" type="submit" style={{ opacity: input.trim() ? 1 : 0.55 }}>{t('assistant.interview.send')}</Btn>
          )}
        </form>
        {/* The terminal CTA — deliberately the loudest thing in the sheet once
            there's an answer to write up (it used to be a ghost button users
            overlooked). */}
        <Btn
          kind={canFinish ? 'primary' : 'ghost'}
          size="md"
          icon="feather"
          onClick={() => canFinish && finishInterview()}
          style={{ opacity: canFinish ? 1 : 0.45 }}
        >
          {t('assistant.interview.finish')}
        </Btn>
      </div>
    </>
  );

  // ── phase: freeform brief ──
  const briefBody = (
    <>
      <div style={{ flex: 1, overflowY: 'auto', padding: desk ? '16px 22px' : '14px 18px' }}>
        <p style={{ ...pStyle }}>{t('assistant.interview.briefHint')}</p>
      </div>
      <div style={{ borderTop: '1px solid var(--line)', padding: desk ? '12px 22px 16px' : '10px 18px 18px' }}>
        <form onSubmit={(e) => { e.preventDefault(); submitBrief(); }} style={{ display: 'flex', gap: 9, alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            value={input}
            rows={2}
            onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitBrief(); } }}
            placeholder={t('assistant.interview.briefPlaceholder')}
            style={{ flex: 1, resize: 'none', fontFamily: 'var(--ui)', fontSize: 14, lineHeight: 1.5, color: 'var(--ink)', padding: '11px 14px', borderRadius: 12, background: 'var(--paper)', border: '1px solid var(--line)', outline: 'none' }}
          />
          <Btn kind="primary" size="md" type="submit" style={{ opacity: input.trim() ? 1 : 0.55 }}>{t('assistant.interview.draft')}</Btn>
        </form>
      </div>
    </>
  );

  // ── phase: review the synthesized draft ──
  const reviewBody = (
    <>
      <div style={{ flex: 1, overflowY: 'auto', padding: desk ? '16px 22px' : '14px 18px' }}>
        {draft ? (
          <DocPreview json={JSON.stringify(markdownToDoc(draft))} text={draft} />
        ) : (
          <p style={{ ...pStyle, color: 'var(--ink-3)' }}>{busy ? t('assistant.interview.writing') : error ? '' : t('assistant.interview.nothingWritten')}</p>
        )}
        {error && <p style={{ ...pStyle, color: 'var(--accent-ink)', marginTop: 12 }}>{error}</p>}
      </div>
      <div style={{ borderTop: '1px solid var(--line)', padding: desk ? '12px 22px 16px' : '10px 18px 18px', display: 'flex', gap: 10 }}>
        {busy ? (
          <Btn kind="ghost" size="md" onClick={() => abortRef.current?.abort()} style={{ flex: 1 }}>{t('assistant.stop')}</Btn>
        ) : (
          <>
            <Btn kind="ghost" size="md" onClick={onClose} style={{ flex: 1 }}>{t('assistant.discard')}</Btn>
            <Btn kind="primary" size="md" onClick={save} style={{ flex: 2, opacity: draft.trim() ? 1 : 0.55 }}>
              {t('assistant.interview.save')}
            </Btn>
          </>
        )}
      </div>
    </>
  );

  const title =
    phase === 'brief' ? t('assistant.interview.freeform')
    : phase === 'review' ? (type ? type.name : t('assistant.interview.yourDraft'))
    : type?.name || t('assistant.interview.fallbackTitle');

  return (
    <AssistantPanel desk={desk} icon="mic" title={title} provider={provider} onClose={onClose} vp={vp} panelRef={panelRef}>
      {phase === 'interview' ? interviewBody : phase === 'brief' ? briefBody : reviewBody}
    </AssistantPanel>
  );
}
