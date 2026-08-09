// The realtime fallback: play everything into a canvas and re-record it.
//
// Used only where WebCodecs is unavailable — notably Firefox Android, and iOS
// 16.4–18.7 where WebCodecs shipped video-only. It is genuinely worse than the
// worker path and the UI says so:
//   • Strictly wall-clock. A six-minute film takes six minutes.
//   • Backgrounding kills it. captureStream() stops producing in a hidden tab
//     and rAF is throttled to ~1 Hz, so a phone call or a lock screen during
//     the render truncates the film. We watch visibilitychange and fail loudly
//     rather than hand back a silently ruined video.
//   • The container is whatever MediaRecorder makes here (WebM on Firefox,
//     MP4 on Safari), not our choice.
//
// Loaded via dynamic import from ./film, so none of this reaches the main
// bundle on the browsers that use the fast path.
import { renderTitleCard } from './cards';
import type { FilmJob, FilmResult, RenderProgress } from './film';
import { RenderCanceled } from './film';
import { pickMimeType } from '../ui/recorder';
import { canonicalSize } from './timeline';

/** Read one clip's natural size and duration without decoding it fully. */
function probeClip(blob: Blob): Promise<{ width: number; height: number; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const el = document.createElement('video');
    el.preload = 'metadata';
    el.muted = true;
    const done = (fn: () => void): void => {
      URL.revokeObjectURL(url);
      el.removeAttribute('src');
      fn();
    };
    el.onloadedmetadata = () =>
      done(() =>
        resolve({
          width: el.videoWidth || 1280,
          height: el.videoHeight || 720,
          // Safari's MediaRecorder writes a zeroed duration, so this can be
          // Infinity/NaN. The caller falls back to the recorded wall clock.
          durationMs: Number.isFinite(el.duration) ? el.duration * 1000 : 0,
        }),
      );
    el.onerror = () => done(() => reject(new Error('could not read clip')));
    el.src = url;
  });
}

export function renderRealtime(
  job: FilmJob,
  onProgress: (p: RenderProgress) => void,
  fps: number,
  cardSeconds: number,
): { promise: Promise<FilmResult>; cancel: () => void } {
  let canceled = false;
  // While a clip is playing, cancel must also stop the <video> element and
  // settle the playback promise — the flag alone only stops the draw loop, and
  // the promise would otherwise sit unresolved until the clip's natural end
  // (a 90-second answer keeps playing decrypted media for 85 more seconds).
  let interruptPlayback: (() => void) | null = null;
  const cancel = (): void => {
    canceled = true;
    interruptPlayback?.();
  };

  const promise = (async (): Promise<FilmResult> => {
    const check = (): void => {
      if (canceled) throw new RenderCanceled();
    };
    check();

    // Measure every clip once, up front: clip 0's dimensions set the canvas
    // geometry, and the durations feed the progress estimate below.
    const probes = await Promise.all(job.clips.map((c) => probeClip(c.blob).catch(() => null)));
    const first = probes[0];
    if (!first) throw new Error('could not read clip');
    const { width, height } = canonicalSize(first.width, first.height);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    const cards = await Promise.all(
      job.clips.map((c) => renderTitleCard(c.question, c.number, job.total, width, height)),
    );

    const audioCtx = new AudioContext({ sampleRate: 48_000 });
    const dest = audioCtx.createMediaStreamDestination();
    // A constant silent source keeps the audio track alive across the title
    // cards — a track that stops producing leaves a hole the muxer resolves as
    // drift rather than silence.
    const keepAlive = audioCtx.createConstantSource();
    keepAlive.offset.value = 0;
    keepAlive.connect(dest);
    keepAlive.start();

    const videoStream = canvas.captureStream(fps);
    const mixed = new MediaStream([...videoStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(mixed, mimeType ? { mimeType } : undefined);
    const parts: BlobPart[] = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) parts.push(ev.data);
    };

    // A hidden tab stops driving captureStream; better to fail than to save a
    // truncated film the user only discovers later.
    let interrupted = false;
    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') interrupted = true;
    };
    document.addEventListener('visibilitychange', onHidden);

    const startedAt = Date.now();
    // Cards + measured clip durations, so the progress bar means something
    // (unreadable durations count as ~30 s rather than zero).
    const estimatedTotalMs =
      job.clips.length * cardSeconds * 1000 + probes.reduce((a, p) => a + (p?.durationMs || 30_000), 0);

    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

    const tick = (phase: RenderProgress['phase']): void => {
      const elapsed = Date.now() - startedAt;
      onProgress({
        phase,
        ratio: estimatedTotalMs > 0 ? Math.min(1, elapsed / estimatedTotalMs) : 0,
        engine: 'realtime',
      });
    };

    await audioCtx.resume().catch(() => undefined);
    recorder.start(1000);

    try {
      for (let i = 0; i < job.clips.length; i++) {
        check();
        if (interrupted) throw new Error('rendering was interrupted');

        // ── the card: hold a still for cardSeconds of wall clock ──
        ctx.drawImage(cards[i], 0, 0, width, height);
        const cardUntil = Date.now() + cardSeconds * 1000;
        while (Date.now() < cardUntil) {
          check();
          // Redraw every frame: captureStream only emits on canvas changes.
          ctx.drawImage(cards[i], 0, 0, width, height);
          await wait(1000 / fps);
          tick('encode');
        }

        // ── the answer: play it into the canvas ──
        const url = URL.createObjectURL(job.clips[i].blob);
        const el = document.createElement('video');
        el.src = url;
        el.playsInline = true;
        const source = audioCtx.createMediaElementSource(el);
        source.connect(dest);
        try {
          await new Promise<void>((resolve, reject) => {
            interruptPlayback = () => {
              el.pause();
              reject(new RenderCanceled());
            };
            el.onerror = () => reject(new Error('could not play clip'));
            el.onended = () => resolve();
            const draw = (): void => {
              if (el.ended || canceled) return;
              const scale = Math.min(width / (el.videoWidth || width), height / (el.videoHeight || height));
              const dw = Math.round((el.videoWidth || width) * scale);
              const dh = Math.round((el.videoHeight || height) * scale);
              ctx.fillStyle = '#000';
              ctx.fillRect(0, 0, width, height);
              ctx.drawImage(el, Math.round((width - dw) / 2), Math.round((height - dh) / 2), dw, dh);
              tick('encode');
              requestAnimationFrame(draw);
            };
            el.onplaying = () => requestAnimationFrame(draw);
            el.play().catch(reject);
          });
        } finally {
          interruptPlayback = null;
          source.disconnect();
          el.pause();
          el.removeAttribute('src');
          URL.revokeObjectURL(url);
        }
        check();
      }

      if (interrupted) throw new Error('rendering was interrupted');
      onProgress({ phase: 'finalize', ratio: 1, engine: 'realtime' });

      const blob = await new Promise<Blob>((resolve) => {
        recorder.onstop = () => resolve(new Blob(parts, { type: recorder.mimeType || 'video/webm' }));
        recorder.stop();
      });
      return {
        blob,
        durationMs: Date.now() - startedAt,
        width,
        height,
        engine: 'realtime',
      };
    } finally {
      document.removeEventListener('visibilitychange', onHidden);
      if (recorder.state !== 'inactive') recorder.stop();
      keepAlive.stop();
      videoStream.getTracks().forEach((t) => t.stop());
      await audioCtx.close().catch(() => undefined);
      for (const c of cards) c.close();
    }
  })();

  return { promise, cancel };
}
