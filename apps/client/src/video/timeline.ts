// Timeline math for a stitched interview film: title card, answer, title card,
// answer… Pure and dependency-free so it can be checked without a codec.
//
// Everything is counted in whole output frames rather than seconds. That is the
// point of this module: the encoder writes each frame at `frame / FPS`, so a
// segment boundary can never land between frames and per-clip rounding error
// cannot accumulate across a six-question film. Source timestamps are never
// passed through — clips at 24, 30, and 60 fps all land on the same clock.

/** How long each question card holds before its answer. Lives here rather than
 *  in ./cards so the encoder worker can read it without importing DOM code. */
export const CARD_SECONDS = 2.5;

/** The film's canonical output clock. */
export const FILM_FPS = 30;

export interface Segment {
  kind: 'card' | 'clip';
  /** Which question this belongs to (0-based). */
  index: number;
  /** Start on the output clock, derived from whole frames. */
  startS: number;
  durationS: number;
  frames: number;
}

export interface Timeline {
  segments: Segment[];
  totalS: number;
  totalFrames: number;
}

/**
 * Lay out one card + one answer per question.
 * `clipDurations` are seconds, in question order; a skipped question is simply
 * not in the list (the caller drops it along with its card).
 */
export function planTimeline(clipDurations: number[], fps: number, cardSeconds: number): Timeline {
  const cardFrames = Math.max(1, Math.round(cardSeconds * fps));
  const segments: Segment[] = [];
  let frame = 0;
  clipDurations.forEach((seconds, index) => {
    segments.push({ kind: 'card', index, startS: frame / fps, durationS: cardFrames / fps, frames: cardFrames });
    frame += cardFrames;
    // A clip always contributes at least one frame — a zero-length take would
    // otherwise leave its title card hanging with nothing after it.
    const clipFrames = Math.max(1, Math.round(seconds * fps));
    segments.push({ kind: 'clip', index, startS: frame / fps, durationS: clipFrames / fps, frames: clipFrames });
    frame += clipFrames;
  });
  return { segments, totalS: frame / fps, totalFrames: frame };
}

/** Rough wall-clock estimate shown before a render starts. */
export function estimateSeconds(clipDurations: number[], cardSeconds: number): number {
  return clipDurations.reduce((a, b) => a + b, 0) + clipDurations.length * cardSeconds;
}
