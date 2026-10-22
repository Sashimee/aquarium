import {
  frameTimedMaxTier,
  lowerTier,
  TIER_COST,
  TIER_GPU_SHARE,
  TIERS,
  tierIndex,
  type Tier,
} from './tiers';

export type TimingSignal = 'gpu' | 'frame';

const GPU_SPAN_TOLERANCE = 1.1;

export interface ProbeInput {
  /** Per-frame timings in ms measured while rendering at `probeTier`. */
  samples: readonly number[];
  signal: TimingSignal;
  probeTier: Tier;
  targetMs: number;
  /**
   * The display's frame interval. Frame intervals cannot drop below it, so only a probe that runs
   * at this rate shows the device keeping up. Defaults to `targetMs`.
   */
  refreshMs?: number;
  /** The highest tier the device class may start at. Defaults to ultra. */
  maxTier?: Tier;
  /** Fraction of the target a GPU-timed tier may use, leaving room for CPU work and spikes. */
  gpuHeadroom?: number;
  /** A frame-interval median within this ratio of the target counts as "keeping up". */
  frameTolerance?: number;
}

export interface ProbeResult {
  tier: Tier;
  medianMs: number | null;
  reason: string;
}

export function median(values: readonly number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const lower = sorted[(sorted.length - 1) >> 1];
  const upper = sorted[sorted.length >> 1];
  if (lower === undefined || upper === undefined) return null;
  return (lower + upper) / 2;
}

/**
 * A GPU time over the frame interval cannot be one frame's work, so the timestamps it sums span
 * several frames (seen on iOS, where they read 23-56 ms at a steady 60 fps) and mean nothing.
 */
export function gpuTimeSpansFrames(gpuMs: number, frameMs: number): boolean {
  return frameMs > 0 && gpuMs > frameMs * GPU_SPAN_TOLERANCE;
}

/** With `gpuShare`, a tier's budget is only its `TIER_GPU_SHARE` of `budgetMs`. */
function highestTierWithin(
  medianMs: number,
  probeTier: Tier,
  budgetMs: number,
  maxTier: Tier,
  gpuShare: boolean,
): Tier | null {
  for (const tier of TIERS.slice(0, tierIndex(maxTier) + 1).reverse()) {
    const budget = gpuShare ? budgetMs * TIER_GPU_SHARE[tier] : budgetMs;
    if ((medianMs * TIER_COST[tier]) / TIER_COST[probeTier] <= budget) return tier;
  }
  return null;
}

/**
 * Picks the starting tier from the start-up timing probe.
 *
 * GPU timestamps measure real work, so they are extrapolated to every tier, each held to its
 * `TIER_GPU_SHARE` of the budget. A frame interval is clamped by vsync and cannot reveal headroom,
 * so a device that keeps up at the probe tier starts there and the adaptive controller climbs
 * further if it can, never into a tier that needs measured GPU headroom.
 */
export function selectInitialTier(input: ProbeInput): ProbeResult {
  const { samples, signal, targetMs } = input;
  const refreshMs = input.refreshMs ?? targetMs;
  const maxTier = input.maxTier ?? 'ultra';
  const probeTier = input.probeTier;
  const gpuHeadroom = input.gpuHeadroom ?? 0.8;
  const frameTolerance = input.frameTolerance ?? 1.1;
  const medianMs = median(samples);

  if (medianMs === null) {
    return {
      tier: lowerTier('medium', maxTier),
      medianMs,
      reason: 'no timing samples during probe',
    };
  }

  if (signal === 'gpu') {
    const tier =
      highestTierWithin(medianMs, probeTier, targetMs * gpuHeadroom, maxTier, true) ?? 'low';
    return { tier, medianMs, reason: `gpu ${medianMs.toFixed(2)} ms at ${probeTier}` };
  }

  const frameMax = lowerTier(probeTier, frameTimedMaxTier(maxTier));
  if (medianMs <= refreshMs * frameTolerance) {
    return {
      tier: frameMax,
      medianMs,
      reason: `frame ${medianMs.toFixed(2)} ms keeps up`,
    };
  }
  const tier =
    highestTierWithin(medianMs, probeTier, targetMs * frameTolerance, frameMax, false) ?? 'low';
  return { tier, medianMs, reason: `frame ${medianMs.toFixed(2)} ms at ${probeTier}` };
}
