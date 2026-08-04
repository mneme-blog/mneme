// Camera modal: live preview → record (MediaRecorder) → review → attach.
// The captured Blob never leaves this component except via onCapture; encryption
// and upload happen in the data layer (state/data.tsx addMedia).
import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../i18n';
import { Icon } from './Icon';
import { Btn } from './primitives';
import { cameraConstraints, fmtDuration, pickMimeType, recorderOptions } from './recorder';

// The format choice and duration formatting live in ./recorder.ts, shared with
// the multi-take video-interview session. Re-exported here because several
// modules already import fmtDuration from this file.
export { fmtDuration };

type Stage = 'idle' | 'recording' | 'review' | 'error';

export function VideoCapture({
  desk,
  onClose,
  onCapture,
}: {
  desk: boolean;
  onClose: () => void;
  onCapture: (blob: Blob, durationMs: number) => void;
}): VNode {
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);

  const liveRef = useRef<HTMLVideoElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const startedAt = useRef(0);
  const result = useRef<{ blob: Blob; durationMs: number } | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  // Acquire the camera on mount; release everything on unmount.
  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia(cameraConstraints())
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((track) => track.stop());
          return;
        }
        stream.current = s;
        if (liveRef.current) liveRef.current.srcObject = s;
      })
      .catch(() => {
        if (!cancelled) {
          setError(t('media.record.cameraUnavailable'));
          setStage('error');
        }
      });
    return () => {
      cancelled = true;
      if (tick.current) clearInterval(tick.current);
      if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  // Review object URLs are revoked when replaced or on unmount.
  useEffect(() => () => { if (reviewUrl) URL.revokeObjectURL(reviewUrl); }, [reviewUrl]);

  const startRecording = (): void => {
    const s = stream.current;
    if (!s) return;
    const mimeType = pickMimeType();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(s, recorderOptions(mimeType));
    } catch {
      setError(t('media.record.unsupported'));
      setStage('error');
      return;
    }
    const parts: BlobPart[] = [];
    rec.ondataavailable = (ev) => { if (ev.data.size > 0) parts.push(ev.data); };
    rec.onstop = () => {
      const durationMs = Date.now() - startedAt.current;
      const blob = new Blob(parts, { type: rec.mimeType || 'video/webm' });
      result.current = { blob, durationMs };
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
    tick.current = setInterval(() => setElapsed(Date.now() - startedAt.current), 250);
    setStage('recording');
  };

  const stopRecording = (): void => {
    if (tick.current) clearInterval(tick.current);
    recorder.current?.stop();
  };

  const retake = (): void => {
    result.current = null;
    setReviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    setStage('idle');
    // Re-bind the still-open stream after the <video> remounts.
    requestAnimationFrame(() => {
      if (liveRef.current && stream.current) liveRef.current.srcObject = stream.current;
    });
  };

  const use = (): void => {
    if (result.current) onCapture(result.current.blob, result.current.durationMs);
    onClose();
  };

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(30,22,16,.45)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: desk ? 'center' : 'flex-end', justifyContent: 'center' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: desk ? 480 : '100%', boxSizing: 'border-box', background: 'var(--surface)', borderRadius: desk ? 20 : '24px 24px 0 0', border: '1px solid var(--line)', padding: desk ? 22 : '18px 18px 28px', boxShadow: '0 20px 60px rgba(30,20,12,.3)' }}
      >
        {!desk && <div style={{ width: 38, height: 4, borderRadius: 9, background: 'var(--line)', margin: '0 auto 14px' }} />}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h3 style={{ fontFamily: 'var(--serif)', fontSize: 19, fontWeight: 500, color: 'var(--ink)', margin: 0 }}>
            {stage === 'review' ? t('media.record.reviewTitle') : t('media.record.videoTitle')}
          </h3>
          <button onClick={onClose} title={t('common.close')} style={{ width: 32, height: 32, borderRadius: 10, border: '1px solid var(--line)', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            <Icon name="x" size={16} color="var(--ink-2)" />
          </button>
        </div>

        {stage === 'error' ? (
          <div style={{ padding: '34px 10px', textAlign: 'center', color: 'var(--ink-2)', fontFamily: 'var(--ui)', fontSize: 14 }}>{error}</div>
        ) : (
          <div style={{ position: 'relative', borderRadius: 14, overflow: 'hidden', background: '#1a140e', border: '1px solid var(--line)' }}>
            {stage === 'review' && reviewUrl ? (
              <video src={reviewUrl} controls playsInline style={{ display: 'block', width: '100%', maxHeight: '52vh' }} />
            ) : (
              <video ref={liveRef} autoPlay muted playsInline style={{ display: 'block', width: '100%', maxHeight: '52vh', transform: 'scaleX(-1)' }} />
            )}
            {stage === 'recording' && (
              <span style={{ position: 'absolute', top: 10, left: 10, display: 'inline-flex', alignItems: 'center', gap: 7, background: 'rgba(20,14,8,.7)', borderRadius: 999, padding: '4px 11px' }}>
                <span style={{ width: 9, height: 9, borderRadius: 9, background: '#E4573D' }} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: '#fff' }}>{fmtDuration(elapsed)}</span>
              </span>
            )}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 16 }}>
          {stage === 'idle' && <Btn onClick={startRecording} icon="video">{t('media.record.start')}</Btn>}
          {stage === 'recording' && <Btn kind="danger" onClick={stopRecording}>{t('media.record.stop')}</Btn>}
          {stage === 'review' && (
            <>
              <Btn kind="ghost" onClick={retake}>{t('media.record.retake')}</Btn>
              <Btn onClick={use} icon="check">{t('media.record.useVideo')}</Btn>
            </>
          )}
          {stage === 'error' && <Btn kind="ghost" onClick={onClose}>{t('common.close')}</Btn>}
        </div>
      </div>
    </div>
  );
}
