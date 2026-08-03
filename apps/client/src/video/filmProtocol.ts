// Messages between the render controller (video/film.ts) and the encoder
// worker, mirroring the shape of db/protocol.ts.
//
// The exchange is deliberately two round-trips:
//   main → 'probe'   (the clip Blobs)
//   worker → 'probed' (the canonical output size + each clip's real duration)
//   main → 'cards'   (title cards rasterized at exactly that size)
//   worker → 'progress'… → 'done'
// The worker has to measure the clips before anyone knows how big a card
// should be, and cards are drawn on the main thread where the app's fonts are
// certain — so neither side can guess the other's half.
//
// Blobs and ImageBitmaps are structured-cloneable, so nothing is base64'd; the
// finished file comes back as a transferable ArrayBuffer.

export interface ProbeMessage {
  t: 'probe';
  clips: Blob[];
}

export interface CardsMessage {
  t: 'cards';
  cards: ImageBitmap[];
}

export interface CancelMessage {
  t: 'cancel';
}

export type ToWorker = ProbeMessage | CardsMessage | CancelMessage;

export interface ProbedMessage {
  t: 'probed';
  width: number;
  height: number;
  /** Measured per clip, in seconds — not the recorder's wall-clock guess. */
  durations: number[];
}

export interface ProgressMessage {
  t: 'progress';
  phase: 'probe' | 'encode' | 'finalize';
  frame: number;
  totalFrames: number;
}

export interface DoneMessage {
  t: 'done';
  buffer: ArrayBuffer;
  mime: string;
  durationMs: number;
  width: number;
  height: number;
}

export interface ErrorMessage {
  t: 'error';
  message: string;
}

export interface CanceledMessage {
  t: 'canceled';
}

export type FromWorker = ProbedMessage | ProgressMessage | DoneMessage | ErrorMessage | CanceledMessage;
