// Microphone modal: record (MediaRecorder) → review → attach. Mirrors
// VideoCapture's stage machine; the captured Blob never leaves this component
// except via onCapture; encryption and upload happen in the data layer
// (state/data.tsx addMedia).
import type { VNode } from 'preact';
import { useRef } from 'preact/hooks';
import { t } from '../i18n';
import { Icon } from './Icon';
import { Btn } from './primitives';
import { Sheet, Z } from './Sheet';
import { useMediaRecorder } from './useMediaRecorder';
import { fmtDuration } from './recorder';

// Preferred container/codec order; the browser picks the first it supports
// (Safari records mp4, everyone else webm/opus). The chosen type rides along
// in the Blob and is stored as the attachment's mime.
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
}

// Scrolling bar waveform: one bar of mic level every BAR_INTERVAL_MS, newest on
// the right. Confirms at a glance that sound is actually being picked up.
const BAR_INTERVAL_MS = 50;
const BAR_W = 3;
const BAR_GAP = 2;

export function AudioCapture({
  desk,
  onClose,
  onCapture,
}: {
  desk: boolean;
  onClose: () => void;
  onCapture: (blob: Blob, durationMs: number) => void;
}): VNode {
  // Live waveform plumbing: an AnalyserNode taps the mic stream (analysis only,
  // never routed to speakers) and a rAF loop paints level bars onto the canvas.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const raf = useRef<number | null>(null);
  const bars = useRef<number[]>([]);
  const lastBarAt = useRef(0);

  const stopWave = (): void => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    analyser.current = null;
    void audioCtx.current?.close().catch(() => undefined);
    audioCtx.current = null;
  };

  const startWave = (s: MediaStream): void => {
    try {
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      ctx.createMediaStreamSource(s).connect(an);
      audioCtx.current = ctx;
      analyser.current = an;
    } catch {
      return; // no waveform — recording itself still works
    }
    bars.current = [];
    lastBarAt.current = 0;
    const samples = new Uint8Array(1024);
    const draw = (now: number): void => {
      raf.current = requestAnimationFrame(draw);
      const an = analyser.current;
      const canvas = canvasRef.current;
      if (!an || !canvas) return;

      // Peak amplitude of the current frame, 0 (silence) … 1 (clipping).
      an.getByteTimeDomainData(samples);
      let peak = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = Math.abs(samples[i] - 128) / 128;
        if (v > peak) peak = v;
      }
      if (now - lastBarAt.current >= BAR_INTERVAL_MS) {
        lastBarAt.current = now;
        bars.current.push(peak);
      }

      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const g = canvas.getContext('2d');
      if (!g || w === 0) return;

      const step = (BAR_W + BAR_GAP) * dpr;
      const maxBars = Math.ceil(w / step);
      if (bars.current.length > maxBars) bars.current.splice(0, bars.current.length - maxBars);

      g.clearRect(0, 0, w, h);
      // Faint centerline so silence still reads as "listening".
      g.fillStyle = getComputedStyle(canvas).getPropertyValue('--line').trim() || '#e0d5c5';
      g.fillRect(0, (h - dpr) / 2, w, dpr);
      g.fillStyle = '#E4573D';
      g.beginPath();
      const list = bars.current;
      for (let i = 0; i < list.length; i++) {
        const x = w - (list.length - i) * step;
        const bh = Math.max(2 * dpr, list[i] * (h - 4 * dpr));
        g.roundRect(x, (h - bh) / 2, BAR_W * dpr, bh, (BAR_W / 2) * dpr);
      }
      g.fill();
    };
    raf.current = requestAnimationFrame(draw);
  };

  const rec = useMediaRecorder({
    acquire: () => navigator.mediaDevices.getUserMedia({ audio: true }),
    makeRecorder: (s) => {
      const mimeType = pickMimeType();
      return new MediaRecorder(s, mimeType ? { mimeType } : undefined);
    },
    fallbackMime: 'audio/webm',
    unavailableMessage: t('media.record.micUnavailable'),
    onStart: startWave,
    onStop: stopWave,
  });
  const { stage, error, elapsed, reviewUrl } = rec;

  const use = (): void => {
    if (rec.result.current) onCapture(rec.result.current.blob, rec.result.current.durationMs);
    onClose();
  };

  return (
    <Sheet
      desk={desk}
      onClose={onClose}
      zIndex={Z.overlay}
      dim="strong"
      width={420}
      cardStyle={{ padding: desk ? 22 : '18px 18px 28px' }}
      title={stage === 'review' ? t('media.record.reviewTitle') : t('media.record.audioTitle')}
      headerMargin="0 0 14px"
      accessory={
        <button onClick={onClose} title={t('common.close')} style={{ width: 32, height: 32, borderRadius: 10, border: '1px solid var(--line)', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <Icon name="x" size={16} color="var(--ink-2)" />
        </button>
      }
    >
      {stage === 'error' ? (
        <div style={{ padding: '34px 10px', textAlign: 'center', color: 'var(--ink-2)', fontFamily: 'var(--ui)', fontSize: 14 }}>{error}</div>
      ) : stage === 'review' && reviewUrl ? (
        <audio src={reviewUrl} controls style={{ display: 'block', width: '100%' }} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '26px 16px', borderRadius: 14, background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
          {stage === 'recording' ? (
            <>
              <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: 56 }} />
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <span style={{ width: 9, height: 9, borderRadius: 9, background: 'var(--danger)' }} />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 15, color: 'var(--ink)' }}>{fmtDuration(elapsed)}</span>
              </span>
            </>
          ) : (
            <>
              <span style={{ width: 54, height: 54, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)', border: '1px solid var(--line)' }}>
                <Icon name="mic" size={24} color="var(--ink-2)" />
              </span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 15, color: 'var(--ink-3)' }}>{t('media.record.ready')}</span>
            </>
          )}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 16 }}>
        {stage === 'idle' && <Btn onClick={rec.startRecording} icon="mic">{t('media.record.start')}</Btn>}
        {stage === 'recording' && <Btn kind="danger" onClick={rec.stopRecording}>{t('media.record.stop')}</Btn>}
        {stage === 'review' && (
          <>
            <Btn kind="ghost" onClick={rec.retake}>{t('media.record.retake')}</Btn>
            <Btn onClick={use} icon="check">{t('media.record.useAudio')}</Btn>
          </>
        )}
        {stage === 'error' && <Btn kind="ghost" onClick={onClose}>{t('common.close')}</Btn>}
      </div>
    </Sheet>
  );
}
