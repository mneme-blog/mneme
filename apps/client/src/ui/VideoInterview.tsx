// Guided video interview — the on-camera counterpart of GuidedInterview.tsx.
//
// The difference that shapes everything: the model never hears a recorded
// answer, so there is nothing to adapt to mid-session. It therefore plans the
// WHOLE question list in one call up front (ai/plan.ts + ai/prompts.ts), the
// user edits that plan if they want, and then the recording phase makes zero AI
// calls and touches the network not at all.
//
// One camera stream is held across every take — acquired when the record phase
// opens, released on unmount — with a fresh MediaRecorder per question. That is
// why this doesn't reuse VideoCapture, which owns its stream for a single take.
//
// Saving follows import/run.ts: createEntry (synchronous) → addMedia per clip →
// updateEntry with the assembled document. The entry is labelled with the
// interview type's name, which is what buildInterviewHistory matches next time.
import type { JSX, VNode } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Icon } from './Icon';
import { Btn } from './primitives';
import { ConfirmDialog } from './ConfirmDialog';
import { ProviderBadge } from './ProviderBadge';
import { useVisualViewport } from '../hooks/useVisualViewport';
import { fmtDuration, pickMimeType } from './recorder';
import { t } from '../i18n';
import { useAppData } from '../state/data';
import type { InterviewType, MediaAttachment } from '../sync/engine';
import { makeProvider } from '../ai/provider';
import { videoInterviewPlanPrompt, videoInterviewPlanUserMessage } from '../ai/prompts';
import { toPlan, PLAN_TARGET, PLAN_MAX } from '../ai/plan';
import { buildInterviewHistory, HISTORY_BUDGET_CHARS } from '../ai/interview';
import { buildVideoInterviewDoc, type VideoInterviewCard } from '../editor/videointerviewData';
import { docToText } from '../editor/doc';
import { newMediaId } from '../sync/ids';
import { toAiError } from '../ai/types';

const pStyle: JSX.CSSProperties = { fontFamily: 'var(--ui)', fontSize: 13, lineHeight: 1.55, color: 'var(--ink-2)', margin: 0 };

// How long a single answer may run before recording stops itself. Device-local
// like the theme and the language — never synced, never content. Deliberately
// NOT a field on InterviewType: sync/engine.ts encodes that record field by
// field, so a new field would be silently stripped the moment an older build
// edits and re-pushes the record (LWW field loss, no conflict, no warning).
const MAX_SECONDS_KEY = 'mneme.videoInterview.maxSeconds';
const DEFAULT_MAX_SECONDS = 90;

function maxSeconds(): number {
  const raw = Number(localStorage.getItem(MAX_SECONDS_KEY));
  return Number.isFinite(raw) && raw >= 15 && raw <= 600 ? raw : DEFAULT_MAX_SECONDS;
}

type Phase = 'pick' | 'planning' | 'plan' | 'record' | 'saving';
type Stage = 'idle' | 'recording' | 'review';

interface Take {
  blob: Blob;
  durationMs: number;
}

export function VideoInterviewSheet({
  desk,
  onClose,
  onOpenEntry,
  onManageTypes,
  journalId,
  initial,
}: {
  desk: boolean;
  onClose: () => void;
  /** Open the freshly-saved entry in the editor. */
  onOpenEntry: (id: string) => void;
  /** Hand off to the interview-types manager (the sheet closes first). */
  onManageTypes: () => void;
  /** Notebook a saved interview entry lands in; defaults to the first journal. */
  journalId?: string;
  /** Preselected start — skips the pick phase. */
  initial?: InterviewType;
}): VNode | null {
  const { entries, journals, interviewTypes, aiSettings, createEntry, updateEntry, addMedia } = useAppData();

  const [phase, setPhase] = useState<Phase>('pick');
  const [type, setType] = useState<InterviewType | null>(null);
  const [questions, setQuestions] = useState<string[]>([]);
  const [planFallback, setPlanFallback] = useState(false);
  const [index, setIndex] = useState(0);
  const [stage, setStage] = useState<Stage>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [error, setError] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Takes are indexed to match `questions`; a hole is a skipped question.
  const takes = useRef<(Take | null)[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const startedAt = useRef(0);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const liveRef = useRef<HTMLVideoElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const provider = useMemo(() => (aiSettings?.enabled ? makeProvider(aiSettings) : null), [aiSettings]);
  const alive = useMemo(() => interviewTypes.filter((it) => !it.deleted), [interviewTypes]);
  const vp = useVisualViewport();
  const limit = useMemo(() => maxSeconds(), []);

  // Release the camera and cancel any in-flight plan request on unmount.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (tick.current) clearInterval(tick.current);
      if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  // Review object URLs are revoked when replaced or on unmount.
  useEffect(() => () => { if (reviewUrl) URL.revokeObjectURL(reviewUrl); }, [reviewUrl]);

  // Opened with a preselected type — skip the pick phase once.
  const startedRef = useRef(false);
  useEffect(() => {
    if (!initial || startedRef.current || !provider) return;
    startedRef.current = true;
    void planQuestions(initial);
  });

  if (!provider || !aiSettings) return null;

  const anyTake = (): boolean => takes.current.some((x) => x);

  // ── plan phase ──────────────────────────────────────────────
  // One call, then nothing. A failure is not fatal: the fallback set means the
  // session still works with the provider unreachable.
  const planQuestions = async (it: InterviewType): Promise<void> => {
    setType(it);
    setPhase('planning');
    setError('');
    const ac = new AbortController();
    abortRef.current = ac;
    const history = buildInterviewHistory(
      entries,
      it.name,
      provider.local ? Math.round(HISTORY_BUDGET_CHARS / 2) : HISTORY_BUDGET_CHARS,
    );
    try {
      const raw = await provider.chat({
        system: videoInterviewPlanPrompt(it, history.text, PLAN_TARGET),
        messages: [{ role: 'user', content: videoInterviewPlanUserMessage(PLAN_TARGET) }],
        // Generous: a verbose model truncated mid-question at 600 in testing,
        // and a truncated last line is silently dropped by the parser.
        maxTokens: 900,
        signal: ac.signal,
      });
      if (ac.signal.aborted) return;
      const plan = toPlan(raw);
      setQuestions(plan.questions);
      setPlanFallback(plan.fallback);
    } catch (e) {
      if (toAiError(e).hint === 'aborted') return;
      const plan = toPlan('');
      setQuestions(plan.questions);
      setPlanFallback(true);
    }
    setPhase('plan');
  };

  const editQuestion = (i: number, value: string): void =>
    setQuestions((qs) => qs.map((q, n) => (n === i ? value : q)));
  const removeQuestion = (i: number): void => setQuestions((qs) => qs.filter((_, n) => n !== i));
  const moveQuestion = (i: number, by: number): void =>
    setQuestions((qs) => {
      const to = i + by;
      if (to < 0 || to >= qs.length) return qs;
      const next = [...qs];
      [next[i], next[to]] = [next[to], next[i]];
      return next;
    });
  const addQuestion = (): void => setQuestions((qs) => (qs.length >= PLAN_MAX ? qs : [...qs, '']));

  // ── record phase ────────────────────────────────────────────
  const startRecording = async (): Promise<void> => {
    const clean = questions.map((q) => q.trim()).filter(Boolean);
    if (clean.length === 0) return;
    setQuestions(clean);
    takes.current = clean.map(() => null);
    setIndex(0);
    setStage('idle');
    setError('');
    setPhase('record');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
      stream.current = s;
      if (liveRef.current) liveRef.current.srcObject = s;
    } catch {
      setError(t('assistant.video.cameraUnavailable'));
    }
  };

  // Bind the (still open) stream whenever the live element remounts — leaving
  // the review player and the preview as two separate <video> elements avoids
  // swapping srcObject↔src on one, which reliably black-frames on Safari.
  useEffect(() => {
    if (phase === 'record' && stage !== 'review' && liveRef.current && stream.current) {
      liveRef.current.srcObject = stream.current;
    }
  }, [phase, stage, index]);

  const stopRecording = (): void => {
    if (tick.current) clearInterval(tick.current);
    tick.current = null;
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
  };

  const record = (): void => {
    const s = stream.current;
    if (!s) return;
    const mimeType = pickMimeType();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(s, mimeType ? { mimeType } : undefined);
    } catch {
      setError(t('assistant.video.unsupported'));
      return;
    }
    const parts: BlobPart[] = [];
    rec.ondataavailable = (ev) => { if (ev.data.size > 0) parts.push(ev.data); };
    rec.onstop = () => {
      const durationMs = Date.now() - startedAt.current;
      const blob = new Blob(parts, { type: rec.mimeType || 'video/webm' });
      takes.current[index] = { blob, durationMs };
      setReviewUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(blob);
      });
      setStage('review');
    };
    recorder.current = rec;
    startedAt.current = Date.now();
    setElapsed(0);
    rec.start(1000); // gather data every second so a crash loses little
    tick.current = setInterval(() => {
      const ms = Date.now() - startedAt.current;
      setElapsed(ms);
      if (ms >= limit * 1000) stopRecording();
    }, 250);
    setStage('recording');
  };

  const clearReview = (): void =>
    setReviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });

  const goTo = (i: number): void => {
    clearReview();
    setIndex(i);
    // Step back onto an already-recorded question and it opens in review, so a
    // stray tap can't silently overwrite the take.
    setStage(takes.current[i] ? 'review' : 'idle');
    if (takes.current[i]) {
      const take = takes.current[i];
      if (take) setReviewUrl(URL.createObjectURL(take.blob));
    }
  };

  const retake = (): void => {
    takes.current[index] = null;
    clearReview();
    setStage('idle');
  };

  const next = (): void => {
    if (index + 1 < questions.length) goTo(index + 1);
    else void save();
  };

  const skip = (): void => {
    takes.current[index] = null;
    next();
  };

  // ── save ────────────────────────────────────────────────────
  // createEntry is synchronous, so the entry id exists before the clips do —
  // the same create → attach → write-back order import/run.ts uses.
  const save = async (): Promise<void> => {
    if (!anyTake() || !type) {
      setError(t('assistant.video.noClips'));
      return;
    }
    setPhase('saving');
    setSavedCount(0);
    const entry = createEntry({
      journalId: journalId ?? journals[0]?.id ?? 'j-personal',
      labels: [type.name],
    });
    const cards: VideoInterviewCard[] = [];
    for (let i = 0; i < questions.length; i++) {
      const take = takes.current[i];
      let att: MediaAttachment | null = null;
      if (take) {
        // addMedia returns null on a zero-byte blob — record it as unanswered
        // rather than aborting a session the user already sat through.
        att = await addMedia(entry.id, 'video', take.blob, {
          durationMs: take.durationMs,
          name: `q${i + 1}`,
        });
        setSavedCount((n) => n + 1);
      }
      cards.push({ q: questions[i], clip: att });
    }
    const doc = buildVideoInterviewDoc({
      sessionId: newMediaId(),
      typeName: type.name,
      cards,
      film: null,
      renderedAt: null,
    });
    updateEntry(entry.id, { bodyJson: JSON.stringify(doc), bodyText: docToText(doc) });
    onOpenEntry(entry.id);
    onClose();
  };

  // Closing mid-session would strand recordings the user just sat through.
  const requestClose = (): void => {
    if (phase === 'saving') return;
    if (phase === 'record' && anyTake()) setConfirmDiscard(true);
    else onClose();
  };

  // ── layout ──────────────────────────────────────────────────
  const answered = takes.current.filter(Boolean).length;
  const shell: JSX.CSSProperties = desk
    ? { width: 'min(460px, 42vw)', flexShrink: 0, borderInlineStart: '1px solid var(--line)', background: 'var(--surface)', display: 'flex', flexDirection: 'column', height: '100%' }
    : { position: 'fixed', insetInline: 0, bottom: 0, zIndex: 70, height: Math.round(vp.height * 0.9), background: 'var(--surface)', borderRadius: '24px 24px 0 0', border: '1px solid var(--line)', display: 'flex', flexDirection: 'column', boxShadow: '0 -12px 40px rgba(30,20,12,.22)' };

  return (
    <div ref={panelRef} style={shell}>
      {!desk && <div style={{ width: 38, height: 4, borderRadius: 9, background: 'var(--line)', margin: '10px auto 4px' }} />}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
        <Icon name="film" size={17} color="var(--accent-ink)" />
        <h3 style={{ flex: 1, minWidth: 0, fontFamily: 'var(--serif)', fontSize: 18, fontWeight: 500, color: 'var(--ink)', margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {type ? type.name : t('assistant.video.title')}
        </h3>
        <ProviderBadge provider={provider} />
        <button onClick={requestClose} title={t('common.close')} style={{ width: 30, height: 30, borderRadius: 9, border: '1px solid var(--line)', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <Icon name="x" size={15} color="var(--ink-2)" />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
        {/* ── pick ── */}
        {phase === 'pick' && (
          <>
            <p style={{ ...pStyle, marginBottom: 14 }}>{t('assistant.video.pickIntro')}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {alive.map((it) => (
                <button
                  key={it.id}
                  onClick={() => void planQuestions(it)}
                  style={{ textAlign: 'start', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 13, padding: '11px 13px', cursor: 'pointer' }}
                >
                  <span style={{ display: 'block', fontFamily: 'var(--ui)', fontSize: 13.5, fontWeight: 600, color: 'var(--ink)' }}>{it.name}</span>
                  <span style={{ display: 'block', fontFamily: 'var(--ui)', fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>{it.intro}</span>
                </button>
              ))}
            </div>
            <button
              onClick={onManageTypes}
              style={{ marginTop: 12, fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--accent-ink)', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
            >
              {t('assistant.interview.manageTypes')}
            </button>
          </>
        )}

        {/* ── planning ── */}
        {phase === 'planning' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, color: 'var(--ink-3)', fontFamily: 'var(--ui)', fontSize: 13, padding: '30px 0' }}>
            <Icon name="feather" size={16} color="var(--ink-3)" />
            {t('assistant.video.planning')}
          </div>
        )}

        {/* ── plan review ── */}
        {phase === 'plan' && (
          <>
            <h4 style={{ fontFamily: 'var(--ui)', fontSize: 12, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--ink-3)', margin: '0 0 6px' }}>
              {t('assistant.video.planTitle')}
            </h4>
            <p style={{ ...pStyle, marginBottom: 12 }}>{t('assistant.video.planHint')}</p>
            {planFallback && (
              <p style={{ ...pStyle, color: 'var(--ink-3)', fontStyle: 'italic', marginBottom: 12 }}>{t('assistant.video.planFailed')}</p>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {questions.map((q, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', paddingTop: 10, width: 14, flexShrink: 0 }}>{i + 1}</span>
                  <textarea
                    value={q}
                    rows={2}
                    placeholder={t('assistant.video.questionPlaceholder')}
                    onInput={(e) => editQuestion(i, (e.target as HTMLTextAreaElement).value)}
                    style={{ flex: 1, minWidth: 0, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'var(--serif)', fontSize: 14, lineHeight: 1.4, color: 'var(--ink)', background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 10, padding: '7px 9px' }}
                  />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
                    <button onClick={() => moveQuestion(i, -1)} disabled={i === 0} title={t('assistant.video.moveUp')} style={miniBtn(i === 0)}>
                      <Icon name="left" size={12} color="var(--ink-3)" />
                    </button>
                    <button onClick={() => moveQuestion(i, 1)} disabled={i === questions.length - 1} title={t('assistant.video.moveDown')} style={miniBtn(i === questions.length - 1)}>
                      <Icon name="right" size={12} color="var(--ink-3)" />
                    </button>
                    <button onClick={() => removeQuestion(i)} title={t('assistant.video.removeQuestion')} style={miniBtn(false)}>
                      <Icon name="x" size={12} color="var(--ink-3)" />
                    </button>
                  </span>
                </div>
              ))}
            </div>
            {questions.length < PLAN_MAX && (
              <button onClick={addQuestion} style={{ marginTop: 10, fontFamily: 'var(--ui)', fontSize: 12.5, fontWeight: 600, color: 'var(--accent-ink)', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}>
                {t('assistant.video.addQuestion')}
              </button>
            )}
            <p style={{ ...pStyle, color: 'var(--ink-3)', fontSize: 12, marginTop: 12 }}>
              {t('assistant.video.maxLength', { seconds: String(limit) })}
            </p>
          </>
        )}

        {/* ── record ── */}
        {phase === 'record' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>
                {t('assistant.video.progress', { n: String(index + 1), total: String(questions.length) })}
              </span>
              <span style={{ flex: 1, display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                {questions.map((_, i) => (
                  <span
                    key={i}
                    onClick={() => stage !== 'recording' && goTo(i)}
                    style={{ width: 8, height: 8, borderRadius: 999, cursor: stage === 'recording' ? 'default' : 'pointer', background: takes.current[i] ? 'var(--accent-ink)' : 'transparent', border: `1px ${i === index ? 'solid' : 'dashed'} ${i === index ? 'var(--accent-ink)' : 'var(--line)'}` }}
                  />
                ))}
              </span>
            </div>

            <p style={{ fontFamily: 'var(--serif)', fontSize: 17, lineHeight: 1.4, color: 'var(--ink)', margin: '0 0 12px' }}>
              {questions[index]}
            </p>

            {error ? (
              <p style={{ ...pStyle, color: 'var(--ink-3)', padding: '24px 0', textAlign: 'center' }}>{error}</p>
            ) : (
              <div style={{ position: 'relative', borderRadius: 14, overflow: 'hidden', background: '#1a140e', border: '1px solid var(--line)' }}>
                {stage === 'review' && reviewUrl ? (
                  <video src={reviewUrl} controls playsInline style={{ display: 'block', width: '100%', maxHeight: '42vh' }} />
                ) : (
                  <video ref={liveRef} autoPlay muted playsInline style={{ display: 'block', width: '100%', maxHeight: '42vh', transform: 'scaleX(-1)' }} />
                )}
                {stage === 'recording' && (
                  <span style={{ position: 'absolute', top: 10, insetInlineStart: 10, display: 'inline-flex', alignItems: 'center', gap: 7, background: 'rgba(20,14,8,.7)', borderRadius: 999, padding: '4px 11px' }}>
                    <span style={{ width: 9, height: 9, borderRadius: 9, background: '#E4573D' }} />
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: '#fff' }}>{fmtDuration(elapsed)}</span>
                  </span>
                )}
              </div>
            )}
          </>
        )}

        {/* ── saving ── */}
        {phase === 'saving' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '40px 0', color: 'var(--ink-3)', fontFamily: 'var(--ui)', fontSize: 13 }}>
            <Icon name="film" size={20} color="var(--ink-3)" />
            {t('assistant.video.savingClip', { n: String(Math.min(savedCount + 1, answered)), total: String(answered) })}
          </div>
        )}
      </div>

      {/* ── actions ── */}
      {(phase === 'plan' || phase === 'record') && (
        <div style={{ borderTop: '1px solid var(--line)', padding: '12px 16px', display: 'flex', gap: 8, alignItems: 'center' }}>
          {phase === 'plan' && questions.some((q) => q.trim()) && (
            <Btn onClick={() => void startRecording()} icon="video">
              {t('assistant.video.start')}
            </Btn>
          )}
          {phase === 'record' && !error && (
            <>
              {index > 0 && stage !== 'recording' && (
                <Btn kind="quiet" onClick={() => goTo(index - 1)}>{t('assistant.video.back')}</Btn>
              )}
              <span style={{ flex: 1 }} />
              {stage === 'idle' && (
                <>
                  <Btn kind="ghost" onClick={skip}>{t('assistant.video.skip')}</Btn>
                  <Btn onClick={record} icon="video">{t('assistant.video.record')}</Btn>
                </>
              )}
              {stage === 'recording' && <Btn kind="danger" onClick={stopRecording}>{t('assistant.video.stop')}</Btn>}
              {stage === 'review' && (
                <>
                  <Btn kind="ghost" onClick={retake}>{t('assistant.video.retake')}</Btn>
                  <Btn onClick={next} icon="check">
                    {index + 1 < questions.length ? t('assistant.video.useAndNext') : t('assistant.video.finish')}
                  </Btn>
                </>
              )}
            </>
          )}
          {phase === 'record' && !error && stage !== 'recording' && anyTake() && index + 1 < questions.length && (
            <Btn kind="quiet" onClick={() => void save()}>{t('assistant.video.finish')}</Btn>
          )}
        </div>
      )}

      {confirmDiscard && (
        <ConfirmDialog
          icon="film"
          title={t('assistant.video.discardTitle')}
          confirmLabel={t('assistant.video.discard')}
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={onClose}
        >
          {t('assistant.video.discardBody')}
        </ConfirmDialog>
      )}
    </div>
  );
}

function miniBtn(disabled: boolean): JSX.CSSProperties {
  return {
    width: 22,
    height: 20,
    borderRadius: 6,
    border: '1px solid var(--line)',
    background: 'transparent',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    padding: 0,
  };
}
