export const AUDIO_SAMPLE_RATE = 48000;

const PRE_FILTER = {
  b: [1.53512485958697, -2.69169618940638, 1.19839281085285],
  a: [1, -1.69065929318241, 0.73248077421585],
} as const;
const RLB_FILTER = {
  b: [1, -2, 1],
  a: [1, -1.99004745483398, 0.99007225036621],
} as const;

const BLOCK_S = 0.4;
const STEP_S = 0.1;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = 10;

function biquad(
  input: Float64Array,
  { b, a }: { b: readonly [number, number, number]; a: readonly [number, number, number] },
): Float64Array {
  const out = new Float64Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i]!;
    const y0 = b[0] * x0 + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

function lufs(meanSquare: number): number {
  return meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity;
}

/**
 * ITU-R BS.1770-4 integrated loudness of a mono signal at 48 kHz. A clip shorter than one
 * 400 ms gating block (the one-shots) has no gating blocks, so it is measured as a single block.
 */
export function integratedLoudness(samples: Float32Array): number {
  if (samples.length === 0) throw new Error('cannot measure the loudness of an empty signal');
  const weighted = biquad(biquad(Float64Array.from(samples), PRE_FILTER), RLB_FILTER);
  const square = new Float64Array(weighted.length + 1);
  for (let i = 0; i < weighted.length; i++) square[i + 1] = square[i]! + weighted[i]! ** 2;
  const meanSquare = (from: number, to: number) => (square[to]! - square[from]!) / (to - from);

  const block = Math.round(BLOCK_S * AUDIO_SAMPLE_RATE);
  const step = Math.round(STEP_S * AUDIO_SAMPLE_RATE);
  if (weighted.length < block) return lufs(meanSquare(0, weighted.length));

  const blocks: number[] = [];
  for (let start = 0; start + block <= weighted.length; start += step) {
    blocks.push(meanSquare(start, start + block));
  }
  const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;
  const aboveAbsolute = blocks.filter((v) => lufs(v) > ABSOLUTE_GATE_LUFS);
  if (aboveAbsolute.length === 0) return -Infinity;
  const relativeGate = lufs(mean(aboveAbsolute)) - RELATIVE_GATE_LU;
  const gated = aboveAbsolute.filter((v) => lufs(v) > relativeGate);
  return lufs(mean(gated));
}

export function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  return peak;
}

export function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

export function linearToDb(linear: number): number {
  return 20 * Math.log10(linear);
}

export interface Normalised {
  samples: Float32Array;
  gainDb: number;
  peakLimited: boolean;
}

/** Scales to the target loudness, backing off when the sample peak would pass the ceiling. */
export function normaliseLoudness(
  samples: Float32Array,
  targetLufs: number,
  peakCeilingDb: number,
): Normalised {
  const measured = integratedLoudness(samples);
  if (!Number.isFinite(measured)) throw new Error('the clip is silent; nothing to normalise');
  const peak = peakOf(samples);
  let gainDb = targetLufs - measured;
  const ceilingGainDb = peakCeilingDb - linearToDb(peak);
  const peakLimited = gainDb > ceilingGainDb;
  if (peakLimited) gainDb = ceilingGainDb;
  const gain = dbToLinear(gainDb);
  return { samples: samples.map((s) => s * gain), gainDb, peakLimited };
}

/**
 * Look-ahead peak limiter: the gain needed at each sample is the minimum over the next
 * `lookaheadSamples`, smoothed by a moving average over the same span, so no sample exceeds the
 * ceiling and the gain ramps instead of clicking. With `wrap` the look-ahead and the smoothing run
 * around the end of the clip, so a loop gets the same gain on both sides of its seam.
 */
export function limitPeaks(
  samples: Float32Array,
  ceilingDb: number,
  lookaheadSamples: number,
  wrap = false,
): Float32Array {
  const ceiling = dbToLinear(ceilingDb);
  const n = samples.length;
  const need = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(samples[i]!);
    need[i] = a > ceiling ? ceiling / a : 1;
  }
  const span = wrap ? n + lookaheadSamples : n;
  const needAt = (i: number) => (i < n ? need[i]! : wrap ? need[i % n]! : 1);
  const lead = new Float64Array(n);
  const window: number[] = [];
  let head = 0;
  for (let i = span - 1; i >= 0; i--) {
    while (window.length > head && needAt(window[window.length - 1]!) >= needAt(i)) window.pop();
    window.push(i);
    while (window[head]! > i + lookaheadSamples) head++;
    if (i < n) lead[i] = needAt(window[head]!);
  }
  const leadAt = (i: number) => (i >= 0 ? lead[i]! : wrap ? lead[((i % n) + n) % n]! : lead[0]!);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + lead[i]!;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const from = i - lookaheadSamples + 1;
    let sum: number;
    if (from >= 0) sum = prefix[i + 1]! - prefix[from]!;
    else {
      sum = prefix[i + 1]!;
      for (let j = from; j < 0; j++) sum += leadAt(j);
    }
    out[i] = samples[i]! * (sum / lookaheadSamples);
  }
  return out;
}

const TARGET_TOLERANCE_LU = 0.05;

/**
 * Gain that brings the limited signal to `targetLufs`. Limiting lowers the loudness, so the gain is
 * searched rather than computed; the search stops when the target is hit or the clip cannot reach it,
 * and `peakLimited` says the limiter held the clip below the target.
 */
export function limitedNormalise(
  samples: Float32Array,
  targetLufs: number,
  peakCeilingDb: number,
  lookaheadSamples: number,
  wrap = false,
): Normalised {
  const measured = integratedLoudness(samples);
  if (!Number.isFinite(measured)) throw new Error('the clip is silent; nothing to normalise');
  const render = (gainDb: number) =>
    limitPeaks(
      samples.map((s) => s * dbToLinear(gainDb)),
      peakCeilingDb,
      lookaheadSamples,
      wrap,
    );
  let low = targetLufs - measured;
  let high = low + 30;
  let best = render(low);
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    const candidate = render(mid);
    if (integratedLoudness(candidate) > targetLufs) high = mid;
    else {
      low = mid;
      best = candidate;
    }
  }
  const peakLimited = targetLufs - integratedLoudness(best) > TARGET_TOLERANCE_LU;
  return { samples: best, gainDb: low, peakLimited };
}

/** Keeps the span from the first to the last sample at or above the threshold, plus a margin. */
export function trimSilence(
  samples: Float32Array,
  thresholdDb: number,
  marginSamples: number,
): Float32Array {
  const threshold = dbToLinear(thresholdDb);
  let first = -1;
  let last = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]!) >= threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) throw new Error(`no sample reaches ${thresholdDb} dBFS; the clip is silent`);
  return samples.slice(
    Math.max(0, first - marginSamples),
    Math.min(samples.length, last + 1 + marginSamples),
  );
}

export function fadeIn(samples: Float32Array, length: number): Float32Array {
  const out = samples.slice();
  const n = Math.min(length, out.length);
  for (let i = 0; i < n; i++) out[i]! *= 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / n);
  return out;
}

export function fadeOut(samples: Float32Array, length: number): Float32Array {
  const out = samples.slice();
  const n = Math.min(length, out.length);
  for (let i = 0; i < n; i++) {
    out[out.length - 1 - i]! *= 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / n);
  }
  return out;
}

/**
 * Turns `segment` (loop length + fade) into a loop of `segment.length - fade` samples. The first
 * `fade` samples crossfade, equal power, from the audio that follows the loop end into the loop
 * start, so the last output sample flows straight into the first one.
 */
export function loopCrossfade(segment: Float32Array, fade: number): Float32Array {
  if (fade <= 0 || fade * 2 > segment.length) {
    throw new Error(`crossfade of ${fade} samples does not fit a ${segment.length}-sample segment`);
  }
  const length = segment.length - fade;
  const out = segment.slice(0, length);
  for (let i = 0; i < fade; i++) {
    const angle = ((i + 0.5) / fade) * (Math.PI / 2);
    out[i] = segment[i]! * Math.sin(angle) + segment[length + i]! * Math.cos(angle);
  }
  return out;
}

/** Start sample of the window whose short-term loudness varies least, for cutting a stationary loop. */
export function stationaryStart(samples: Float32Array, windowSamples: number): number {
  const blockSamples = AUDIO_SAMPLE_RATE / 10;
  const blockCount = Math.floor(samples.length / blockSamples);
  const windowBlocks = Math.ceil(windowSamples / blockSamples);
  if (windowBlocks > blockCount) {
    throw new Error(
      `the source is ${(samples.length / AUDIO_SAMPLE_RATE).toFixed(1)} s, shorter than the ${(windowSamples / AUDIO_SAMPLE_RATE).toFixed(1)} s window`,
    );
  }
  const levels: number[] = [];
  for (let b = 0; b < blockCount; b++) {
    let energy = 0;
    for (let i = b * blockSamples; i < (b + 1) * blockSamples; i++) energy += samples[i]! ** 2;
    levels.push(10 * Math.log10(energy / blockSamples + 1e-12));
  }
  let best = 0;
  let bestVariance = Infinity;
  for (let start = 0; start + windowBlocks <= blockCount; start++) {
    const window = levels.slice(start, start + windowBlocks);
    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
    if (variance < bestVariance - 1e-9) {
      bestVariance = variance;
      best = start;
    }
  }
  return best * blockSamples;
}
