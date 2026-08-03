// Headless verification of the film encoder against DELIBERATELY MISMATCHED
// clips — the case the plan calls risk #1. Inputs are synthesized with
// mediabunny (not MediaRecorder), so the test is deterministic and not realtime.
//
// Built and run by scripts/film-e2e.mjs; not part of the app bundle.
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  MkvOutputFormat,
  Mp4OutputFormat,
  Output,
  Quality,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny';
import { renderTitleCard } from '../src/video/cards';
import { CARD_SECONDS, FILM_FPS } from '../src/video/timeline';

const out: string[] = [];
const log = (s: string): void => {
  out.push(s);
  document.getElementById('log')!.textContent = out.join('\n');
};
let failures = 0;
const check = (cond: unknown, msg: string): void => {
  if (!cond) failures++;
  log(`${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
};

interface ClipSpec {
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
  channels: number;
  seconds: number;
  /** Preference order; the first the browser can actually encode is used.
   *  Headless Chrome refuses AAC at 44.1 kHz mono, and Opus only does 48/24/16/
   *  12/8 kHz — PCM in Matroska takes any rate, which is what keeps the
   *  44.1 kHz → 48 kHz resample path under test everywhere. */
  candidates: { container: 'mp4' | 'webm' | 'mkv'; video: VideoCodec; audio: AudioCodec }[];
  hue: number;
}

function formatFor(container: 'mp4' | 'webm' | 'mkv'): Mp4OutputFormat | WebMOutputFormat | MkvOutputFormat {
  if (container === 'mp4') return new Mp4OutputFormat();
  if (container === 'webm') return new WebMOutputFormat();
  return new MkvOutputFormat();
}

/** Synthesize one clip: a moving bar plus a tone, at the given shape. */
async function makeClip(spec: ClipSpec): Promise<Blob> {
  let pick: { container: 'mp4' | 'webm' | 'mkv'; video: VideoCodec; audio: AudioCodec } | null = null;
  for (const c of spec.candidates) {
    const v = await canEncodeVideo(c.video, { width: spec.width, height: spec.height });
    const a = await canEncodeAudio(c.audio, { numberOfChannels: spec.channels, sampleRate: spec.sampleRate });
    if (v && a) {
      pick = c;
      break;
    }
  }
  if (!pick) throw new Error(`no encodable combination for ${spec.width}x${spec.height} @ ${spec.sampleRate}Hz x${spec.channels}`);
  log(`  fixture codec → ${pick.container}/${pick.video}/${pick.audio}`);

  const canvas = new OffscreenCanvas(spec.width, spec.height);
  const ctx = canvas.getContext('2d')!;
  const output = new Output({ format: formatFor(pick.container), target: new BufferTarget() });
  const video = new CanvasSource(canvas, { codec: pick.video, quality: new Quality({ bitrate: 1_500_000 }) });
  const audio = new AudioSampleSource({ codec: pick.audio, quality: new Quality({ bitrate: 96_000 }) });
  output.addVideoTrack(video, { frameRate: spec.fps });
  output.addAudioTrack(audio);
  await output.start();

  const frames = Math.round(spec.seconds * spec.fps);
  for (let f = 0; f < frames; f++) {
    ctx.fillStyle = `hsl(${spec.hue} 60% 30%)`;
    ctx.fillRect(0, 0, spec.width, spec.height);
    ctx.fillStyle = '#fff';
    ctx.fillRect((f / frames) * spec.width, 0, Math.max(8, spec.width / 20), spec.height);
    await video.add(f / spec.fps, 1 / spec.fps);
  }

  // A steady tone, in half-second runs.
  const totalSamples = Math.round(spec.seconds * spec.sampleRate);
  const per = Math.round(spec.sampleRate / 2);
  for (let at = 0; at < totalSamples; at += per) {
    const n = Math.min(per, totalSamples - at);
    const data = new Float32Array(n * spec.channels);
    for (let c = 0; c < spec.channels; c++) {
      for (let i = 0; i < n; i++) {
        data[c * n + i] = Math.sin((2 * Math.PI * 440 * (at + i)) / spec.sampleRate) * 0.2;
      }
    }
    await audio.add(
      new AudioSample({
        data,
        format: 'f32-planar',
        numberOfChannels: spec.channels,
        sampleRate: spec.sampleRate,
        timestamp: at / spec.sampleRate,
      }),
    );
  }

  video.close();
  audio.close();
  await output.finalize();
  const mime = await output.getMimeType();
  return new Blob([(output.target as BufferTarget).buffer!], { type: mime });
}

async function main(): Promise<void> {
  log(`WebCodecs: VideoEncoder=${typeof VideoEncoder} AudioEncoder=${typeof AudioEncoder}`);

  // Two clips that disagree on everything a real session disagrees on:
  // an iOS-shaped MP4/H.264 at 44.1 kHz mono, and a Chrome-shaped WebM/VP8 at
  // 48 kHz stereo, with different resolutions and frame rates.
  const specs: ClipSpec[] = [
    {
      width: 640, height: 480, fps: 24, sampleRate: 44_100, channels: 1, seconds: 2, hue: 10,
      candidates: [
        { container: 'mp4', video: 'avc', audio: 'aac' },
        { container: 'mkv', video: 'vp8', audio: 'pcm-s16' },
        { container: 'webm', video: 'vp8', audio: 'opus' },
      ],
    },
    {
      width: 1280, height: 720, fps: 30, sampleRate: 48_000, channels: 2, seconds: 3, hue: 200,
      candidates: [
        { container: 'webm', video: 'vp8', audio: 'opus' },
        { container: 'mp4', video: 'avc', audio: 'aac' },
      ],
    },
  ];
  const clips: Blob[] = [];
  for (const s of specs) {
    log(`clip ${s.width}x${s.height}@${s.fps}fps ${s.sampleRate}Hz x${s.channels}:`);
    const blob = await makeClip(s);
    clips.push(blob);
    log(`  → ${blob.size} B (${blob.type})`);
  }

  // ── drive the real worker ──
  const worker = new Worker(new URL('../src/video/filmWorker.ts', import.meta.url), { type: 'module' });
  const result = await new Promise<{ buffer: ArrayBuffer; mime: string; durationMs: number; width: number; height: number }>(
    (resolve, reject) => {
      worker.onerror = (e) => reject(new Error(e.message || 'worker error'));
      worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.t === 'probed') {
          log(`probed → ${m.width}x${m.height}, durations ${m.durations.map((d: number) => d.toFixed(2)).join(', ')}`);
          check(Math.abs(m.durations[0] - 2) < 0.3, `clip 1 measured ≈2s (got ${m.durations[0].toFixed(2)})`);
          check(Math.abs(m.durations[1] - 3) < 0.3, `clip 2 measured ≈3s (got ${m.durations[1].toFixed(2)})`);
          void Promise.all([
            renderTitleCard('What stood out today?', 1, 2, m.width, m.height),
            renderTitleCard('What are you carrying into tomorrow?', 2, 2, m.width, m.height),
          ]).then((cards) => worker.postMessage({ t: 'cards', cards }, cards));
          return;
        }
        if (m.t === 'progress') return;
        if (m.t === 'done') resolve(m);
        else reject(new Error(m.t === 'error' ? m.message : m.t));
      };
      worker.postMessage({ t: 'probe', clips });
    },
  );
  worker.terminate();

  const film = new Blob([result.buffer], { type: result.mime });
  log(`film → ${film.size} B, ${result.mime}, ${result.width}x${result.height}, ${result.durationMs} ms`);
  check(film.size > 10_000, 'the film has real content');

  // ── the canonical shape comes from the FIRST clip (640x480 → 4:3) ──
  check(result.width % 2 === 0 && result.height % 2 === 0, 'output dimensions are even (H.264 requires it)');
  check(result.height === 720 || result.width === 720, 'the short edge is 720');

  // ── expected length: clips + one card each ──
  const expected = (2 + 3 + 2 * CARD_SECONDS) * 1000;
  check(
    Math.abs(result.durationMs - expected) < 400,
    `duration ≈ clips + cards (${result.durationMs} vs ${expected} ms)`,
  );

  // ── read the film back and check the tracks really agree ──
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(film) });
  const vt = await input.getPrimaryVideoTrack();
  const at = await input.getPrimaryAudioTrack();
  check(!!vt, 'the film has a video track');
  check(!!at, 'the film has an audio track');
  if (vt && at) {
    check((await vt.getDisplayWidth()) === result.width, 'the muxed width matches');
    const vDur = await vt.computeDuration();
    const aDur = await at.computeDuration();
    log(`track durations → video ${vDur.toFixed(3)}s, audio ${aDur.toFixed(3)}s`);
    // THE assertion this whole test exists for: after concatenating two clips
    // that disagree on frame rate, sample rate and channel count, picture and
    // sound must still end together.
    check(Math.abs(vDur - aDur) < 0.15, `A/V stay in sync across mismatched clips (drift ${(Math.abs(vDur - aDur) * 1000).toFixed(0)} ms)`);
    check(Math.abs(vDur - expected / 1000) < 0.4, `video track ≈ expected length (${vDur.toFixed(2)}s)`);
    check((await at.getSampleRate()) === 48_000, 'audio was normalized to 48 kHz');
    check((await at.getNumberOfChannels()) === 1, 'audio was downmixed to mono');
  }
  input.dispose();

  log(failures === 0 ? '\nALL FILM CHECKS PASSED' : `\n${failures} FILM CHECK(S) FAILED`);
  await fetch('/result', { method: 'POST', body: JSON.stringify({ failures, log: out }) });
}

main().catch(async (e) => {
  log(`FATAL: ${e?.stack || e}`);
  await fetch('/result', { method: 'POST', body: JSON.stringify({ failures: 1, log: out }) });
});
