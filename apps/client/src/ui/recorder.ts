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

// ── capture quality ─────────────────────────────────────────────
// Left unconstrained, getUserMedia hands back whatever the engine feels like —
// in practice 640×480 on Chrome/Safari, but it is genuinely UA- and
// device-dependent, so the same journal can end up with wildly mismatched
// clips. Pinning it matters twice over: the film render adopts the FIRST
// clip's dimensions (video/filmWorker.ts probes it) and derives its own
// bitrate from them, so capture size sets the size of the keepsake too.
//
// Device-local like the per-question time limit, the theme and the language —
// never synced, never content. Deliberately NOT a field on InterviewType:
// sync/engine.ts encodes that record field by field, so a new field would be
// silently stripped the moment an older build edits and re-pushes it.
export type VideoQuality = 'low' | 'medium' | 'high';

/**
 * Frame size + bitrate per level. The bitrate is the real file-size lever:
 * browsers default to ~2.5 Mbps whatever the frame size, so dropping to 360p
 * without capping it barely saves anything. Sizes are 16:9 to match the film
 * output; a 4:3 sensor lands on its nearest mode instead (see `ideal` below).
 */
export const VIDEO_QUALITY: Record<VideoQuality, { width: number; height: number; bitsPerSecond: number }> = {
  low: { width: 640, height: 360, bitsPerSecond: 700_000 },
  medium: { width: 1280, height: 720, bitsPerSecond: 2_000_000 },
  high: { width: 1920, height: 1080, bitsPerSecond: 4_500_000 },
};

const QUALITY_KEY = 'mneme.video.quality';
// 720p: readable full-screen on a laptop, roughly 15 MB per minute of answer,
// and it keeps the rendered film inside the encoder's fast path everywhere.
const DEFAULT_QUALITY: VideoQuality = 'medium';

export function videoQuality(): VideoQuality {
  const raw = localStorage.getItem(QUALITY_KEY);
  return raw === 'low' || raw === 'medium' || raw === 'high' ? raw : DEFAULT_QUALITY;
}

export function setVideoQuality(q: VideoQuality): void {
  localStorage.setItem(QUALITY_KEY, q);
}

/** Roughly how many megabytes a minute of recording costs at each level —
    the number that actually decides this for people, so the picker shows it. */
export function megabytesPerMinute(q: VideoQuality): number {
  return Math.round((VIDEO_QUALITY[q].bitsPerSecond * 60) / 8 / 1_000_000);
}

// How long a single interview answer may run before recording stops itself.
// Device-local for the same reason as the quality above.
const MAX_SECONDS_KEY = 'mneme.videoInterview.maxSeconds';
const DEFAULT_MAX_SECONDS = 90;
/** The presets the picker offers; any value in range stays valid if hand-set. */
export const ANSWER_LIMITS = [30, 60, 90, 180, 300];

export function answerLimitSeconds(): number {
  const raw = Number(localStorage.getItem(MAX_SECONDS_KEY));
  return Number.isFinite(raw) && raw >= 15 && raw <= 600 ? raw : DEFAULT_MAX_SECONDS;
}

export function setAnswerLimitSeconds(seconds: number): void {
  localStorage.setItem(MAX_SECONDS_KEY, String(seconds));
}

/** getUserMedia constraints for a front-facing take at the chosen quality. */
export function cameraConstraints(): MediaStreamConstraints {
  const { width, height } = VIDEO_QUALITY[videoQuality()];
  return {
    // `ideal`, never `exact`: a camera that cannot hit the target must fall
    // back to its closest mode, not throw OverconstrainedError and leave the
    // user with no camera at all.
    video: {
      facingMode: 'user',
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: 30 },
    },
    audio: true,
  };
}

/** MediaRecorder options for a camera take — format plus the bitrate cap. */
export function recorderOptions(mimeType: string | undefined): MediaRecorderOptions {
  const opts: MediaRecorderOptions = { videoBitsPerSecond: VIDEO_QUALITY[videoQuality()].bitsPerSecond };
  if (mimeType) opts.mimeType = mimeType;
  return opts;
}

/** "M:SS" — the clock shown while recording and under a stored clip. */
export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * "M:SS" for time *remaining*. Rounds up, unlike fmtDuration: a countdown that
 * rounded to nearest would sit on 0:00 for half a second while the camera is
 * still rolling, which reads as a frozen or broken timer. 0:00 here means the
 * recorder has actually stopped.
 */
export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
