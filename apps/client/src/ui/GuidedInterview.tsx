// Guided interview — the AI conducts a short Q&A (or a one-line freeform brief),
// then synthesizes a journal entry the user reviews before anything is saved.
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
import { Icon } from './Icon';
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
} from '../ai/prompts';
import { buildInterviewHistory, HISTORY_BUDGET_CHARS } from '../ai/interview';
import {
  buildRetrospect,
  deepReflectionChoice,
  deepReflectionEnabled,
  journalGap,
  RETRO_BUDGET_CHARS,
} from '../ai/reflection';
import { ReflectionConsent } from './ReflectionConsent';
import { markdownToDoc, splitMarkdownTitle, docToText } from '../editor/doc';
import { DocPreview } from '../editor/DocPreview';
import { toAiError, type AiMessage } from '../ai/types';
import { chatErrorMessage } from '../ai/errors';

const pStyle: JSX.CSSProperties = { fontFamily: 'var(--ui)', fontSize: 13, lineHeight: 1.55, color: 'var(--ink-2)', margin: 0 };

// The seed turn that makes the model open with its first question (Anthropic
// requires the conversation to start with a user message). Hidden from the UI.
const SEED: AiMessage = { role: 'user', content: 'Please begin the interview with your first question.' };

type Phase = 'pick' | 'interview' | 'brief' | 'review';

export function GuidedInterviewSheet({
  desk,
  onClose,
  onOpenEntry,
  onManageTypes,
  journalId,
  initial,
  onVideo,
}: {
  desk: boolean;
  onClose: () => void;
  /** Open the freshly-saved entry in the editor. */
  onOpenEntry: (id: string) => void;
  /** Hand off to the interview-types manager (the sheet closes first). */
  onManageTypes: () => void;
  /** Notebook a saved interview entry lands in; defaults to the first journal
      (matches the standalone interview and a normal blank new entry). */
  journalId?: string;
  /** Preselected start (mobile compose chooser) — skips the pick phase. */
  initial?: InterviewType | 'freeform';
  /** Answer this type on camera instead; omit to hide the affordance. */
  onVideo?: (type: InterviewType) => void;
}): VNode | null {
  const { entries, journals, interviewTypes, aiSettings, createEntry } = useAppData();
  const [phase, setPhase] = useState<Phase>('pick');
  // The chosen interview type; null while picking or during a freeform draft.
  const [type, setType] = useState<InterviewType | null>(null);
  // Full API history including the hidden SEED turn; the UI renders messages.slice(1).
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [input, setInput] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The deeper questions (ai/reflection.ts) are opt-in per device: `deep` is the
  // recorded answer, `consentFor` holds the type the user picked while the
  // one-time overlay asks for it.
  const [deep, setDeep] = useState(deepReflectionEnabled);
  const [consentFor, setConsentFor] = useState<InterviewType | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const provider = useMemo(() => (aiSettings?.enabled ? makeProvider(aiSettings) : null), [aiSettings]);
  const alive = useMemo(() => interviewTypes.filter((it) => !it.deleted), [interviewTypes]);
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
  // Opened with a preselected start (the mobile compose chooser) — skip the
  // pick phase once. Guarded on `provider`: without it the render below bails
  // before `startInterview` exists, and the effect must not touch it then.
  const startedRef = useRef(false);
  useEffect(() => {
    if (!initial || startedRef.current || !provider) return;
    startedRef.current = true;
    if (initial === 'freeform') {
      setType(null);
      setInput('');
      setPhase('brief');
    } else {
      startInterview(initial);
    }
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
    if (!on) return interviewSystemPrompt(it, history.text);
    return interviewSystemPrompt(it, history.text, {
      gap,
      // Entries already in the history block are excluded so one entry can't
      // fill two sections of the same prompt.
      retrospect: buildRetrospect(entries, { excludeIds: history.ids, budgetChars: budget(RETRO_BUDGET_CHARS) }),
    });
  };

  const beginInterview = (it: InterviewType, on: boolean): void => {
    setConsentFor(null);
    setType(it);
    setPhase('interview');
    void askTurn(systemFor(it, on), [SEED]);
  };

  // The deeper questions widen what an interview sends out of E2EE under a
  // cloud backend, so the first AI interview on this device asks before it
  // starts. Freeform drafts never reach here — they use no dynamics.
  const startInterview = (it: InterviewType): void => {
    if (deepReflectionChoice() === null) {
      setConsentFor(it);
      return;
    }
    beginInterview(it, deep);
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
    void synthesize(interviewSynthesisPrompt(type), [...qa, { role: 'user', content: interviewSynthesisUserMessage() }]);
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
      // The notebook the compose FAB was in, else the same default as a normal
      // new entry (app.tsx newEntry).
      journalId: journalId ?? journals[0]?.id ?? 'j-personal',
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

  // ── phase: pick an interview type or freeform ──
  const pickBody = (
    <div style={{ flex: 1, overflowY: 'auto', padding: desk ? '16px 22px' : '14px 18px', display: 'flex', flexDirection: 'column', gap: 9 }}>
      <p style={{ ...pStyle, marginBottom: 4 }}>
        {t('assistant.interview.pickIntro')}
      </p>
      {alive.map((it) => (
        // The same type can be typed or filmed — the strategy text is
        // mode-agnostic, so the choice is made here rather than baked into the
        // record. The camera button hands off to the video sheet.
        <div
          key={it.id}
          style={{ display: 'flex', alignItems: 'stretch', gap: 0, borderRadius: 12, background: 'var(--paper)', border: '1px solid var(--line)', overflow: 'hidden' }}
          onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent-line)')}
          onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--line)')}
        >
          <button
            onClick={() => startInterview(it)}
            style={{ flex: 1, minWidth: 0, textAlign: 'start', cursor: 'pointer', padding: '12px 14px', background: 'transparent', border: 'none', display: 'flex', flexDirection: 'column', gap: 3 }}
          >
            <span style={{ fontFamily: 'var(--serif)', fontSize: 15.5, fontWeight: 500, color: 'var(--ink)' }}>{it.name || t('common.untitled')}</span>
            {it.intro && <span style={{ ...pStyle, fontSize: 12.5, color: 'var(--ink-3)' }}>{it.intro}</span>}
          </button>
          {onVideo && (
            <button
              onClick={() => { onClose(); onVideo(it); }}
              title={t('assistant.video.recordInstead')}
              aria-label={t('assistant.video.recordInstead')}
              style={{ flexShrink: 0, width: 46, background: 'transparent', border: 'none', borderInlineStart: '1px solid var(--line)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ink-3)' }}
            >
              <Icon name="video" size={17} color="var(--ink-3)" />
            </button>
          )}
        </div>
      ))}
      <button
        onClick={() => { setType(null); setInput(''); setPhase('brief'); }}
        style={{ textAlign: 'start', cursor: 'pointer', padding: '12px 14px', borderRadius: 12, background: 'var(--surface-2)', border: '1px dashed var(--line)', display: 'flex', flexDirection: 'column', gap: 3 }}
      >
        <span style={{ fontFamily: 'var(--serif)', fontSize: 15.5, fontWeight: 500, color: 'var(--ink)' }}>{t('assistant.interview.freeform')}</span>
        <span style={{ ...pStyle, fontSize: 12.5, color: 'var(--ink-3)' }}>{t('assistant.interview.freeformHint')}</span>
      </button>
      <button
        onClick={() => { onClose(); onManageTypes(); }}
        style={{ alignSelf: 'flex-start', marginTop: 4, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ink-3)', fontFamily: 'var(--ui)', fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <Icon name="list" size={14} /> {t('assistant.interview.manageTypes')}
      </button>
    </div>
  );

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
    phase === 'pick' ? t('assistant.interview.title')
    : phase === 'brief' ? t('assistant.interview.freeform')
    : phase === 'review' ? (type ? type.name : t('assistant.interview.yourDraft'))
    : type?.name || t('assistant.interview.fallbackTitle');

  return (
    <>
      <AssistantPanel desk={desk} icon="mic" title={title} provider={provider} onClose={onClose} vp={vp} panelRef={panelRef}>
        {phase === 'pick' ? pickBody : phase === 'interview' ? interviewBody : phase === 'brief' ? briefBody : reviewBody}
      </AssistantPanel>
      {consentFor && (
        <ReflectionConsent
          provider={provider}
          onDecide={(on) => {
            setDeep(on);
            beginInterview(consentFor, on);
          }}
        />
      )}
    </>
  );
}
