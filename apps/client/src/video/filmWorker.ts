// The film encoder: decodes every answer clip, normalizes it onto one canonical
// video and audio clock, cuts the pre-rendered question cards in between, and
// muxes the result into a single file. Runs in a worker because this is by far
// the heaviest thing the app does, and it must not freeze the editor.
//
// THE LOAD-BEARING IDEA — the integer clock.
// Source timestamps are never passed through. Two integer counters, `frame` and
// `audioFrames`, are the only clock: every video frame is written at
// `frame / FILM_FPS` and every audio run at `audioFrames / RATE`. Clips from one
// session routinely disagree (iOS records 24–30 fps H.264 at 44.1 kHz mono,
// desktop Chrome 30 fps VP9 at 48 kHz stereo), and passing their timestamps
// through — or accumulating per-clip float offsets — is what makes a six-answer
// film drift a second out of sync by the last question. Instead each clip is
// resampled onto the shared clock and its audio padded or trimmed to exactly the
// frame count its video occupies, so picture and sound re-converge at every seam.
//
// Nothing decrypted crosses a trust boundary here: the worker sees the same
// plaintext clip Blobs the <video> element in the entry already plays.
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSampleSink,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type InputAudioTrack,
  type InputVideoTrack,
  type VideoCodec,
  type VideoSample,
} from 'mediabunny';
import { CARD_SECONDS, FILM_FPS, planTimeline } from './timeline';
import { chunkFrames, downmixToMono, fitLength, resampleLinear, silence } from './audiomix';
import type { FromWorker, ToWorker } from './filmProtocol';

/** Output audio: 48 kHz mono. Camera mics are effectively mono anyway, and one
 *  channel removes a whole class of channel-count mismatch between clips. */
const RATE = 48_000;
/** Emit audio in half-second runs so the encoder queue stays small. */
const AUDIO_CHUNK = RATE / 2;

// The tsconfig ships the DOM lib rather than WebWorker (db/worker.ts does the
// same), so the worker global is reached through a cast.
const post = (msg: FromWorker, transfer?: Transferable[]): void =>
  transfer
    ? (self as unknown as Worker).postMessage(msg, transfer)
    : (self as unknown as Worker).postMessage(msg);

let canceled = false;
let clips: Blob[] = [];
let probed: { width: number; height: number; durations: number[] } | null = null;

class Canceled extends Error {}

function checkCanceled(): void {
  if (canceled) throw new Canceled();
}

/** H.264 requires even dimensions; round down rather than up to stay in budget. */
const even = (n: number): number => Math.max(2, Math.floor(n / 2) * 2);

/**
 * The canonical frame size, from the FIRST clip's shape. 720 on the short edge:
 * high enough to look right full-screen, low enough that six 90-second clips
 * re-encode without exhausting a mid-range phone.
 */
function canonicalSize(displayWidth: number, displayHeight: number): { width: number; height: number } {
  const landscape = displayWidth >= displayHeight;
  const short = 720;
  const ratio = landscape ? displayWidth / displayHeight : displayHeight / displayWidth;
  const long = Math.min(1280, Math.max(640, Math.round(short * ratio)));
  return landscape ? { width: even(long), height: even(short) } : { width: even(short), height: even(long) };
}

function bitrateFor(width: number, height: number): number {
  return Math.round(Math.min(6_000_000, Math.max(1_000_000, width * height * FILM_FPS * 0.09)));
}

// ── probe ───────────────────────────────────────────────────
// computeDuration() walks the packets rather than trusting the container. That
// is what immunizes us against Safari's MediaRecorder writing mvhd/tkhd/mdhd
// durations of zero, which makes <video>.duration read Infinity.
async function probe(): Promise<void> {
  const durations: number[] = [];
  let width = 1280;
  let height = 720;
  for (let i = 0; i < clips.length; i++) {
    checkCanceled();
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(clips[i]) });
    try {
      const track = await input.getPrimaryVideoTrack();
      durations.push(await input.computeDuration());
      if (i === 0 && track) {
        const size = canonicalSize(await track.getDisplayWidth(), await track.getDisplayHeight());
        width = size.width;
        height = size.height;
      }
    } finally {
      input.dispose();
    }
    post({ t: 'progress', phase: 'probe', frame: i + 1, totalFrames: clips.length });
  }
  probed = { width, height, durations };
  post({ t: 'probed', width, height, durations });
}

// ── audio ───────────────────────────────────────────────────
/** Decode one clip's audio and normalize it to 48 kHz mono. */
async function readClipAudio(track: InputAudioTrack): Promise<Float32Array> {
  const sink = new AudioSampleSink(track);
  const pieces: Float32Array[] = [];
  let total = 0;
  for await (const sample of sink.samples()) {
    checkCanceled();
    try {
      const planes: Float32Array[] = [];
      for (let c = 0; c < sample.numberOfChannels; c++) {
        const plane = new Float32Array(sample.numberOfFrames);
        sample.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        planes.push(plane);
      }
      const mono = resampleLinear(downmixToMono(planes), sample.sampleRate, RATE);
      pieces.push(mono);
      total += mono.length;
    } finally {
      sample.close();
    }
  }
  const out = new Float32Array(total);
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function writeAudio(source: AudioSampleSource, data: Float32Array, startFrames: number): Promise<number> {
  let written = 0;
  for (const n of chunkFrames(data.length, AUDIO_CHUNK)) {
    checkCanceled();
    const slice = data.subarray(written, written + n);
    // AudioSample keeps a reference, so hand it a copy it can own.
    await source.add(
      new AudioSample({
        data: new Float32Array(slice),
        format: 'f32-planar',
        numberOfChannels: 1,
        sampleRate: RATE,
        timestamp: (startFrames + written) / RATE,
      }),
    );
    written += n;
  }
  return written;
}

// ── video ───────────────────────────────────────────────────
/** Contain-fit one decoded frame into the canonical box, letterboxed on black. */
function paint(
  c2d: OffscreenCanvasRenderingContext2D,
  sample: VideoSample,
  width: number,
  height: number,
): void {
  const sw = sample.displayWidth || width;
  const sh = sample.displayHeight || height;
  const scale = Math.min(width / sw, height / sh);
  const dw = Math.round(sw * scale);
  const dh = Math.round(sh * scale);
  c2d.fillStyle = '#000';
  c2d.fillRect(0, 0, width, height);
  sample.draw(c2d, Math.round((width - dw) / 2), Math.round((height - dh) / 2), dw, dh);
}

// ── encode ──────────────────────────────────────────────────
async function encode(cards: ImageBitmap[]): Promise<void> {
  if (!probed) throw new Error('encode before probe');
  const { width, height, durations } = probed;
  const timeline = planTimeline(durations, FILM_FPS, CARD_SECONDS);

  // MP4/H.264/AAC is the only combination that plays everywhere — iOS, Android,
  // desktop, QuickTime, and whatever the user forwards it to. Fall back to
  // WebM/VP*/Opus wholesale rather than mixing: MP4-with-Opus is legal but
  // silently unplayable in QuickTime and older Safari, which is worse than WebM.
  let vCodec: VideoCodec | null = await getFirstEncodableVideoCodec(['avc'], { width, height });
  let aCodec: AudioCodec | null = await getFirstEncodableAudioCodec(['aac'], { numberOfChannels: 1, sampleRate: RATE });
  let format: Mp4OutputFormat | WebMOutputFormat;
  if (vCodec && aCodec) {
    format = new Mp4OutputFormat();
  } else {
    vCodec = await getFirstEncodableVideoCodec(['vp9', 'vp8'], { width, height });
    aCodec = await getFirstEncodableAudioCodec(['opus'], { numberOfChannels: 1, sampleRate: RATE });
    format = new WebMOutputFormat();
  }
  if (!vCodec || !aCodec) throw new Error('no encodable video/audio codec available');

  const canvas = new OffscreenCanvas(width, height);
  const c2d = canvas.getContext('2d', { alpha: false });
  if (!c2d) throw new Error('OffscreenCanvas 2D context unavailable');

  const output = new Output({ format, target: new BufferTarget() });
  const videoSource = new CanvasSource(canvas, {
    codec: vCodec,
    quality: new Quality({ bitrate: bitrateFor(width, height) }),
  });
  const audioSource = new AudioSampleSource({ codec: aCodec, quality: new Quality({ bitrate: 128_000 }) });
  output.addVideoTrack(videoSource, { frameRate: FILM_FPS });
  output.addAudioTrack(audioSource);
  await output.start();

  // The only clock. Both are whole counts — see the note at the top.
  let frame = 0;
  let audioFrames = 0;
  const cardFrames = timeline.segments.find((s) => s.kind === 'card')?.frames ?? Math.round(CARD_SECONDS * FILM_FPS);

  const reportEvery = 30;
  const tick = (): void => {
    if (frame % reportEvery === 0) {
      post({ t: 'progress', phase: 'encode', frame, totalFrames: timeline.totalFrames });
    }
  };

  try {
    for (let i = 0; i < clips.length; i++) {
      checkCanceled();

      // ── the question card ──
      const bitmap = cards[i];
      if (bitmap) c2d.drawImage(bitmap, 0, 0, width, height);
      else {
        c2d.fillStyle = '#000';
        c2d.fillRect(0, 0, width, height);
      }
      for (let f = 0; f < cardFrames; f++) {
        checkCanceled();
        await videoSource.add(frame / FILM_FPS, 1 / FILM_FPS);
        frame++;
        tick();
      }
      // Real silence, not a hole. A muxer gap around a 2.5 s card is the classic
      // cause of audio arriving a second late by the fourth question.
      audioFrames += await writeAudio(audioSource, silence(Math.round(CARD_SECONDS * RATE)), audioFrames);

      // ── the answer ──
      const clipFrames = timeline.segments.find((s) => s.kind === 'clip' && s.index === i)?.frames ?? 1;
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(clips[i]) });
      try {
        const videoTrack: InputVideoTrack | null = await input.getPrimaryVideoTrack();
        const audioTrack: InputAudioTrack | null = await input.getPrimaryAudioTrack();

        // Audio first: decoding it fully is cheap next to video and lets the
        // seam be padded/trimmed to exactly the frames the picture occupies.
        const want = Math.round((clipFrames / FILM_FPS) * RATE);
        const clipAudio = audioTrack ? await readClipAudio(audioTrack) : new Float32Array(0);
        audioFrames += await writeAudio(audioSource, fitLength(clipAudio, want), audioFrames);

        if (videoTrack) {
          // Pull frames against the output clock, duplicating or dropping as
          // needed — this is what makes a 24 fps iPhone clip and a 30 fps webcam
          // clip land on the same timeline.
          const sink = new VideoSampleSink(videoTrack);
          const iterator = sink.samples()[Symbol.asyncIterator]();
          let cur: VideoSample | null = (await iterator.next()).value ?? null;
          let next: VideoSample | null = cur ? ((await iterator.next()).value ?? null) : null;
          const startFrame = frame;
          const endFrame = frame + clipFrames;
          try {
            while (frame < endFrame) {
              checkCanceled();
              const srcT = (frame - startFrame) / FILM_FPS;
              // Never hold more than two decoded frames at once.
              while (next && next.timestamp <= srcT) {
                cur?.close();
                cur = next;
                next = (await iterator.next()).value ?? null;
              }
              if (cur) paint(c2d, cur, width, height);
              await videoSource.add(frame / FILM_FPS, 1 / FILM_FPS);
              frame++;
              tick();
            }
          } finally {
            cur?.close();
            next?.close();
            // Drain whatever the decoder still holds so it can shut down.
            for (;;) {
              const rest = await iterator.next();
              if (rest.done) break;
              rest.value.close();
            }
          }
        } else {
          // No video track (defensive — our recorder always writes one).
          for (let f = 0; f < clipFrames; f++) {
            await videoSource.add(frame / FILM_FPS, 1 / FILM_FPS);
            frame++;
          }
        }
      } finally {
        input.dispose();
      }
    }

    checkCanceled();
    post({ t: 'progress', phase: 'finalize', frame, totalFrames: timeline.totalFrames });
    videoSource.close();
    audioSource.close();
    await output.finalize();

    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) throw new Error('the encoder produced no output');
    post(
      {
        t: 'done',
        buffer,
        mime: await output.getMimeType(),
        durationMs: Math.round((frame / FILM_FPS) * 1000),
        width,
        height,
      },
      [buffer],
    );
  } catch (e) {
    await output.cancel().catch(() => undefined);
    throw e;
  } finally {
    for (const bitmap of cards) bitmap.close();
  }
}

self.onmessage = (ev: MessageEvent<ToWorker>): void => {
  const msg = ev.data;
  if (msg.t === 'cancel') {
    canceled = true;
    return;
  }
  if (msg.t === 'probe') {
    clips = msg.clips;
    void probe().catch((e) => {
      if (e instanceof Canceled) post({ t: 'canceled' });
      else post({ t: 'error', message: e instanceof Error ? e.message : String(e) });
    });
    return;
  }
  if (msg.t === 'cards') {
    void encode(msg.cards).catch((e) => {
      if (e instanceof Canceled) post({ t: 'canceled' });
      else post({ t: 'error', message: e instanceof Error ? e.message : String(e) });
    });
  }
};
