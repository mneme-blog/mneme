// The single-take MediaRecorder state machine shared by the camera and
// microphone modals. VideoCapture and AudioCapture implemented this twice,
// verbatim (~70%): acquire on mount with a cancelled guard, record with a 1 s
// data timeslice + 250 ms elapsed tick, assemble the blob on stop, hold the
// review object URL (revoked on replace/unmount), release everything on
// unmount. The per-surface differences ride in as options: constraints and
// recorder construction, the unavailable-message copy, and hooks for the live
// <video> binding / the audio waveform tap.
//
// Deliberately NOT used by the video interview: that surface holds ONE camera
// stream across many takes with a fresh recorder per question (see CLAUDE.md —
// re-acquiring per take is exactly what it must avoid), so its machine differs
// in shape, not by accident.
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../i18n';

export type CaptureStage = 'idle' | 'recording' | 'review' | 'error';

export interface UseMediaRecorderOpts {
  /** Acquire the stream (constraints are the surface's choice). */
  acquire: () => Promise<MediaStream>;
  /** Build the recorder (mime/options are the surface's choice); may throw. */
  makeRecorder: (s: MediaStream) => MediaRecorder;
  /** Container fallback when the recorder reports no mimeType. */
  fallbackMime: string;
  /** Copy for a failed acquisition (camera vs. microphone). */
  unavailableMessage: string;
  /** The stream is live (e.g. bind the preview <video>). */
  onStream?: (s: MediaStream) => void;
  /** Recording started / stopped (e.g. the waveform tap). */
  onStart?: (s: MediaStream) => void;
  onStop?: () => void;
}

export function useMediaRecorder(opts: UseMediaRecorderOpts) {
  const [stage, setStage] = useState<CaptureStage>('idle');
  const [error, setError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);

  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const startedAt = useRef(0);
  const result = useRef<{ blob: Blob; durationMs: number } | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  // Latest options for the mount-once effect and the event handlers — callers
  // pass inline closures, and the acquisition must still run exactly once.
  const o = useRef(opts);
  o.current = opts;

  // Acquire on mount; release everything on unmount.
  useEffect(() => {
    let cancelled = false;
    o.current
      .acquire()
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((track) => track.stop());
          return;
        }
        stream.current = s;
        o.current.onStream?.(s);
      })
      .catch(() => {
        if (!cancelled) {
          setError(o.current.unavailableMessage);
          setStage('error');
        }
      });
    return () => {
      cancelled = true;
      if (tick.current) clearInterval(tick.current);
      o.current.onStop?.();
      if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  // Review object URLs are revoked when replaced or on unmount.
  useEffect(() => () => { if (reviewUrl) URL.revokeObjectURL(reviewUrl); }, [reviewUrl]);

  const startRecording = (): void => {
    const s = stream.current;
    if (!s) return;
    let rec: MediaRecorder;
    try {
      rec = o.current.makeRecorder(s);
    } catch {
      setError(t('media.record.unsupported'));
      setStage('error');
      return;
    }
    const parts: BlobPart[] = [];
    rec.ondataavailable = (ev) => { if (ev.data.size > 0) parts.push(ev.data); };
    rec.onstop = () => {
      const durationMs = Date.now() - startedAt.current;
      const blob = new Blob(parts, { type: rec.mimeType || o.current.fallbackMime });
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
    o.current.onStart?.(s);
    setStage('recording');
  };

  const stopRecording = (): void => {
    if (tick.current) clearInterval(tick.current);
    o.current.onStop?.();
    recorder.current?.stop();
  };

  const retake = (): void => {
    result.current = null;
    setReviewUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    setStage('idle');
  };

  return { stage, error, elapsed, reviewUrl, stream, result, startRecording, stopRecording, retake };
}
