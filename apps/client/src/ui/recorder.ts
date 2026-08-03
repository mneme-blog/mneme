// Shared MediaRecorder helpers, used by the one-off capture modals
// (VideoCapture/AudioCapture) and by the multi-take video-interview session.
//
// Kept separate because the session holds ONE camera stream across N recordings
// while the modals own their stream for a single take — the format choice and
// the duration formatting are all they have in common.

// Preferred container/codec order; the browser picks the first it supports
// (Safari records mp4, everyone else webm). The chosen type rides along in the
// Blob and is stored as the attachment's mime.
export const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
];

export function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
}

/** "M:SS" — the clock shown while recording and under a stored clip. */
export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
