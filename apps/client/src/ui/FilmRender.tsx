// The "Render film" flow: a confirmation dialog with an honest estimate, then
// progress, then the finished film written back into the node.
//
// The render itself is owned by video/film.ts, NOT by this component — an
// encode can run for minutes and the user is free to navigate away, so the
// handle lives in a module-level registry and the write-back goes through
// attachFilm (which reads the entry's current body). This dialog is just a view
// onto that, and closing it does not cancel anything.
import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './Icon';
import { Btn } from './primitives';
import { t, tp, fmtNumber } from '../i18n';
import { useAppData } from '../state/data';
import type { MediaAttachment } from '../sync/engine';
import type { VideoInterviewData } from '../editor/videointerviewData';
import {
  RenderCanceled,
  activeRender,
  canRenderWithWebCodecs,
  estimateFilmSeconds,
  renderFilm,
  watchRenderProgress,
  type FilmClip,
  type RenderProgress,
} from '../video/film';
import { fmtDuration } from './recorder';

export interface FilmRenderTarget {
  entryId: string;
  data: VideoInterviewData;
}

type Stage = 'confirm' | 'resolving' | 'rendering' | 'error';

export function FilmRenderDialog({
  target,
  onClose,
}: {
  target: FilmRenderTarget;
  onClose: () => void;
}): VNode {
  const { mediaBlob, addMedia, attachFilm } = useAppData();
  const { entryId, data } = target;

  const running = activeRender(data.sessionId);
  const [stage, setStage] = useState<Stage>(running ? 'rendering' : 'confirm');
  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const [missing, setMissing] = useState(0);
  const [error, setError] = useState('');

  const answered = data.cards.filter((c) => c.clip);
  const supported = canRenderWithWebCodecs() || typeof MediaRecorder !== 'undefined';
  const realtime = !canRenderWithWebCodecs();
  const estimate = estimateFilmSeconds(answered.map((c) => c.clip?.durationMs ?? 0));

  // Follow a render that was already running when the dialog opened — outcome
  // via the handle's promise, progress via the fan-out (this dialog isn't the
  // starter, so its own onProgress callback was never attached).
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const unwatch = watchRenderProgress(data.sessionId, (p) => {
      if (alive && p) setProgress(p);
    });
    running.promise
      .then(() => alive && onClose())
      .catch((e) => {
        if (!alive) return;
        if (e instanceof RenderCanceled) onClose();
        else {
          setError(e instanceof Error ? e.message : String(e));
          setStage('error');
        }
      });
    return () => {
      alive = false;
      unwatch();
    };
  }, [running]);

  // The imperative path below outlives the dialog by design (the render result
  // must land via addMedia/attachFilm even if the user navigated away) — but
  // its setState calls must not fire after unmount, mirroring the effect's
  // `alive` guard above.
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const start = async (): Promise<void> => {
    setStage('resolving');
    // Resolve every clip first: one recorded on another device downloads and
    // decrypts here. Any that can't be reached is left out, and said so.
    const clips: FilmClip[] = [];
    let absent = 0;
    for (let i = 0; i < data.cards.length; i++) {
      const card = data.cards[i];
      if (!card.clip) continue;
      const blob = await mediaBlob(entryId, card.clip);
      if (blob) clips.push({ question: card.q, blob, number: i + 1 });
      else absent++;
    }
    if (mounted.current) setMissing(absent);
    if (clips.length === 0) {
      if (mounted.current) {
        setError(t('media.film.noClips'));
        setStage('error');
      }
      return;
    }

    if (mounted.current) setStage('rendering');
    const handle = renderFilm({ sessionId: data.sessionId, clips, total: data.cards.length }, (p) => {
      if (mounted.current) setProgress(p);
    });
    try {
      const result = await handle.promise;
      const att: MediaAttachment | null = await addMedia(entryId, 'video', result.blob, {
        durationMs: result.durationMs,
        width: result.width,
        height: result.height,
        name: data.typeName || t('media.noun.film'),
      });
      if (att) attachFilm(entryId, data.sessionId, att);
      if (mounted.current) onClose();
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof RenderCanceled) {
        onClose();
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setStage('error');
    }
  };

  const pct = Math.round((progress?.ratio ?? 0) * 100);

  return (
    <div
      role="dialog"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(30,22,16,.45)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 430, maxWidth: '100%', boxSizing: 'border-box', background: 'var(--surface)', borderRadius: 20, border: '1px solid var(--line)', padding: 22, boxShadow: '0 20px 60px rgba(30,20,12,.3)' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={{ width: 36, height: 36, borderRadius: 999, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent-soft)' }}>
            <Icon name="film" size={17} color="var(--accent-ink)" />
          </span>
          <h3 style={{ fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, color: 'var(--ink)', margin: 0 }}>
            {t('media.film.dialogTitle')}
          </h3>
        </div>

        {stage === 'confirm' && (
          <>
            <p style={{ fontFamily: 'var(--ui)', fontSize: 13.5, lineHeight: 1.55, color: 'var(--ink-2)', margin: '0 0 10px' }}>
              {supported ? t('media.film.dialogBody') : t('media.film.unsupported')}
            </p>
            {supported && (
              <>
                <p style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--ink-3)', margin: '0 0 4px' }}>
                  {t('media.film.estimate', { duration: fmtDuration(estimate * 1000) })}
                </p>
                <p style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--ink-3)', margin: '0 0 14px' }}>
                  {t('media.film.addedSize')}
                </p>
                {realtime && (
                  <p style={{ fontFamily: 'var(--ui)', fontSize: 12.5, lineHeight: 1.5, color: 'var(--ink-2)', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 10, padding: '9px 11px', margin: '0 0 14px' }}>
                    {t('media.film.slowWarning')}
                  </p>
                )}
              </>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <Btn kind="ghost" onClick={onClose}>{t('common.cancel')}</Btn>
              {supported && <Btn onClick={() => void start()} icon="film">{t('media.film.start')}</Btn>}
            </div>
          </>
        )}

        {(stage === 'resolving' || stage === 'rendering') && (
          <>
            <p style={{ fontFamily: 'var(--ui)', fontSize: 13.5, color: 'var(--ink-2)', margin: '0 0 12px' }}>
              {t('media.film.rendering', { pct: fmtNumber(pct) })}
            </p>
            <div style={{ height: 6, borderRadius: 999, background: 'var(--surface-2)', overflow: 'hidden', marginBottom: 14 }}>
              <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width .3s ease' }} />
            </div>
            {missing > 0 && (
              <p style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--ink-3)', margin: '0 0 12px' }}>
                {tp('media.film.missingClips', missing)}
              </p>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <Btn kind="ghost" onClick={() => activeRender(data.sessionId)?.cancel()}>{t('common.cancel')}</Btn>
            </div>
          </>
        )}

        {stage === 'error' && (
          <>
            <p style={{ fontFamily: 'var(--ui)', fontSize: 13.5, lineHeight: 1.55, color: 'var(--ink-2)', margin: '0 0 16px' }}>
              {t('media.film.failed')} {error && <span style={{ color: 'var(--ink-3)' }}>({error})</span>}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <Btn kind="ghost" onClick={onClose}>{t('common.close')}</Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
