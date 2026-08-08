// Live status of detached transcription runs, keyed by video-interview session.
//
// The auto-transcribe loop (ui/VideoInterview.tsx) outlives the sheet that
// started it, and the entry it writes into is usually open in the editor — the
// interview card there is the only surface left that can show progress. Same
// module-level-registry idea as video/film.ts, minus cancellation: a run is a
// short sequence of HTTP requests, and each finished clip is already persisted,
// so there is nothing worth tearing down mid-flight.
//
// Progress carries no content — counts only. Transcript text goes straight to
// the entry via attachTranscript, never through here.

export interface TranscribeRunStatus {
  /** Clips finished so far. */
  done: number;
  /** Clips this run set out to transcribe. */
  total: number;
}

const runs = new Map<string, TranscribeRunStatus>();
const watchers = new Map<string, Set<(s: TranscribeRunStatus | null) => void>>();

/** Publish a run's progress; null ends the run (also the error/abort path). */
export function reportTranscribeRun(sessionId: string, status: TranscribeRunStatus | null): void {
  if (status) runs.set(sessionId, status);
  else runs.delete(sessionId);
  for (const cb of watchers.get(sessionId) ?? []) cb(status);
}

/**
 * Follow one session's run from anywhere. The current state is delivered
 * immediately (null when nothing is running), then every update; the end is
 * delivered as null. Returns the unsubscribe.
 */
export function watchTranscribeRun(sessionId: string, cb: (s: TranscribeRunStatus | null) => void): () => void {
  let set = watchers.get(sessionId);
  if (!set) {
    set = new Set();
    watchers.set(sessionId, set);
  }
  set.add(cb);
  cb(runs.get(sessionId) ?? null);
  return () => {
    set.delete(cb);
    if (set.size === 0) watchers.delete(sessionId);
  };
}
