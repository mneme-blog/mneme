// Audio normalization for the stitched film. Pure Float32 maths, no WebAudio —
// so it runs in the encoder worker and can be checked without a codec.
//
// Why this exists: the clips of ONE session routinely disagree. iOS Safari
// records 44100 Hz mono AAC, desktop Chrome records 48000 Hz stereo Opus, and
// a clip synced from another device can be either. The output has exactly one
// audio configuration (48 kHz mono — camera mics are effectively mono anyway,
// and it removes a whole class of channel-count mismatch), so every clip is
// downmixed and resampled onto it before being written.

/** Average interleaved-by-plane channel data down to one channel. */
export function downmixToMono(planes: Float32Array[]): Float32Array {
  if (planes.length === 0) return new Float32Array(0);
  if (planes.length === 1) return planes[0];
  const n = planes[0].length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (const p of planes) sum += p[i] ?? 0;
    out[i] = sum / planes.length;
  }
  return out;
}

/**
 * Linear resample to a new sample rate. Linear rather than sinc deliberately:
 * this is speech from a phone mic being re-encoded at 128 kbit/s, where the
 * interpolation error sits far below the codec's own noise floor, and the
 * simplicity is worth more than the fidelity here.
 */
export function resampleLinear(src: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate || src.length === 0) return src;
  const ratio = srcRate / dstRate;
  const n = Math.max(1, Math.round(src.length / ratio));
  const out = new Float32Array(n);
  const last = src.length - 1;
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    if (i0 >= last) {
      out[i] = src[last];
      continue;
    }
    const frac = pos - i0;
    out[i] = src[i0] * (1 - frac) + src[i0 + 1] * frac;
  }
  return out;
}

/**
 * A run of silent sample-frames.
 *
 * Used under every title card. Emitting real silence rather than leaving a gap
 * in the audio track is what keeps the two clocks together: a muxer hole around
 * a 2.5 s card is the classic cause of audio drifting a second late by the
 * fourth question.
 */
export function silence(frames: number): Float32Array {
  return new Float32Array(Math.max(0, frames));
}

/**
 * Force a run to exactly `frames` samples — pad with silence or cut the tail.
 * Applied at the end of every clip so audio and video re-sync at each seam
 * instead of accumulating that clip's rounding error into the next one.
 */
export function fitLength(data: Float32Array, frames: number): Float32Array {
  if (data.length === frames) return data;
  if (data.length > frames) return data.subarray(0, frames);
  const out = new Float32Array(frames);
  out.set(data);
  return out;
}

/** Split a sample count into chunks, so encoder queues stay small. */
export function chunkFrames(total: number, per: number): number[] {
  const out: number[] = [];
  for (let left = total; left > 0; left -= per) out.push(Math.min(per, left));
  return out;
}
