// The render controller — the only module the UI imports to make a film.
//
// It owns engine selection (WebCodecs in a worker, else the realtime canvas
// fallback), the title-card round-trip, progress, cancellation, and a
// module-level registry of in-flight renders. The registry is what lets the
// user navigate away from the entry mid-encode without killing it: a render is
// tied to a session id, not to a mounted component.
import { CARD_SECONDS, FILM_FPS, estimateSeconds } from './timeline';
import { renderTitleCard } from './cards';
import type { FromWorker, ToWorker } from './filmProtocol';

export interface FilmClip {
  question: string;
  blob: Blob;
  /** Position among ALL the session's questions, for the "n / N" counter. */
  number: number;
}

export interface FilmJob {
  sessionId: string;
  clips: FilmClip[];
  /** Total questions in the session, including skipped ones. */
  total: number;
}

export interface RenderProgress {
  phase: 'probe' | 'encode' | 'finalize';
  /** 0–1. */
  ratio: number;
  engine: FilmEngine;
}

export interface FilmResult {
  blob: Blob;
  durationMs: number;
  width: number;
  height: number;
  engine: FilmEngine;
}

export type FilmEngine = 'webcodecs' | 'realtime';

export interface RenderHandle {
  sessionId: string;
  engine: FilmEngine;
  promise: Promise<FilmResult>;
  cancel(): void;
}

export class RenderCanceled extends Error {
  constructor() {
    super('render canceled');
  }
}

/**
 * Whether the fast path is available.
 *
 * Both encoders must exist, not just VideoEncoder: iOS 16.4–18.7 shipped
 * WebCodecs video-only, and checking only the video half is exactly how apps
 * ended up crashing on iPhone audio.
 */
export function canRenderWithWebCodecs(): boolean {
  return (
    typeof VideoEncoder !== 'undefined' &&
    typeof AudioEncoder !== 'undefined' &&
    typeof VideoDecoder !== 'undefined' &&
    typeof AudioDecoder !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined'
  );
}

/** Rough wall-clock length of the finished film, in seconds. */
export function estimateFilmSeconds(clipDurationsMs: number[]): number {
  return estimateSeconds(clipDurationsMs.map((ms) => ms / 1000), CARD_SECONDS);
}

// In-flight renders, keyed by session id. Survives navigation; cleared when the
// vault locks (see stopAllRenders).
const active = new Map<string, RenderHandle>();

export function activeRender(sessionId: string): RenderHandle | null {
  return active.get(sessionId) ?? null;
}

/** Cancel everything — called on vault lock and vault deletion. */
export function stopAllRenders(): void {
  for (const handle of [...active.values()]) handle.cancel();
  active.clear();
}

function startWorkerRender(job: FilmJob, onProgress: (p: RenderProgress) => void): RenderHandle {
  const worker = new Worker(new URL('./filmWorker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  let canceling = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;

  const promise = new Promise<FilmResult>((resolve, reject) => {
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      worker.terminate();
      active.delete(job.sessionId);
      fn();
    };

    worker.onerror = (e) => finish(() => reject(new Error(e.message || 'render worker failed')));
    worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const msg = ev.data;
      if (msg.t === 'probed') {
        // Cards can only be drawn once the worker has measured the clips, and
        // they are drawn HERE (not in the worker) because the app's fonts are
        // only reliably available on the main thread.
        void Promise.all(
          job.clips.map((clip) => renderTitleCard(clip.question, clip.number, job.total, msg.width, msg.height)),
        )
          .then((cards) => {
            if (settled || canceling) {
              for (const c of cards) c.close();
              return;
            }
            const message: ToWorker = { t: 'cards', cards };
            worker.postMessage(message, cards);
          })
          .catch((e) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))));
        return;
      }
      if (msg.t === 'progress') {
        onProgress({
          phase: msg.phase,
          ratio: msg.totalFrames > 0 ? Math.min(1, msg.frame / msg.totalFrames) : 0,
          engine: 'webcodecs',
        });
        return;
      }
      if (msg.t === 'done') {
        finish(() =>
          resolve({
            blob: new Blob([msg.buffer], { type: msg.mime }),
            durationMs: msg.durationMs,
            width: msg.width,
            height: msg.height,
            engine: 'webcodecs',
          }),
        );
        return;
      }
      if (msg.t === 'canceled') {
        finish(() => reject(new RenderCanceled()));
        return;
      }
      finish(() => reject(new Error(msg.message)));
    };

    const probe: ToWorker = { t: 'probe', clips: job.clips.map((c) => c.blob) };
    worker.postMessage(probe);
  });

  const handle: RenderHandle = {
    sessionId: job.sessionId,
    engine: 'webcodecs',
    promise,
    cancel: () => {
      if (settled || canceling) return;
      canceling = true;
      const msg: ToWorker = { t: 'cancel' };
      worker.postMessage(msg);
      // A wedged encoder must not outlive the cancel.
      watchdog = setTimeout(() => {
        if (settled) return;
        settled = true;
        worker.terminate();
        active.delete(job.sessionId);
      }, 3000);
    },
  };
  // Nothing else awaits this promise, and an unhandled rejection on cancel
  // would surface as a console error.
  promise.catch(() => undefined);
  active.set(job.sessionId, handle);
  return handle;
}

/**
 * Render a film. Returns immediately with a handle; the work continues even if
 * the caller unmounts. Re-requesting a session that is already rendering
 * returns the running handle rather than starting a second encode.
 */
export function renderFilm(job: FilmJob, onProgress: (p: RenderProgress) => void): RenderHandle {
  const running = active.get(job.sessionId);
  if (running) return running;
  if (canRenderWithWebCodecs()) return startWorkerRender(job, onProgress);

  // Realtime fallback — loaded only when needed so its cost never lands in the
  // main bundle for the browsers that don't use it.
  let cancelFn = (): void => undefined;
  const promise = import('./fallback').then((mod) => {
    const handle = mod.renderRealtime(job, onProgress, FILM_FPS, CARD_SECONDS);
    cancelFn = handle.cancel;
    return handle.promise;
  });
  const handle: RenderHandle = {
    sessionId: job.sessionId,
    engine: 'realtime',
    promise: promise.finally(() => active.delete(job.sessionId)),
    cancel: () => cancelFn(),
  };
  handle.promise.catch(() => undefined);
  active.set(job.sessionId, handle);
  return handle;
}
