import { TIER_COST, TIERS, type Tier } from './tiers';

export type TimingSignal = 'gpu' | 'frame';

export interface ProbeInput {
  /** Per-frame timings in ms measured while rendering at `probeTier`. */
  samples: readonly number[];
  signal: TimingSignal;
  probeTier: Tier;
  targetMs: number;
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

function highestTierWithin(medianMs: number, probeTier: Tier, budgetMs: number): Tier | null {
  for (const tier of [...TIERS].reverse()) {
    if ((medianMs * TIER_COST[tier]) / TIER_COST[probeTier] <= budgetMs) return tier;
  }
  return null;
}

/**
 * Picks the starting tier from the start-up timing probe.
 *
 * GPU timestamps measure real work, so they are extrapolated to every tier. A frame
 * interval is clamped by vsync and cannot reveal headroom, so a device that keeps up at
 * the probe tier starts there and the adaptive controller climbs further if it can.
 */
export function selectInitialTier(input: ProbeInput): ProbeResult {
  const { samples, signal, probeTier, targetMs } = input;
  const gpuHeadroom = input.gpuHeadroom ?? 0.8;
  const frameTolerance = input.frameTolerance ?? 1.1;
  const medianMs = median(samples);

  if (medianMs === null) {
    return { tier: 'medium', medianMs, reason: 'no timing samples during probe' };
  }

  if (signal === 'gpu') {
    const tier = highestTierWithin(medianMs, probeTier, targetMs * gpuHeadroom) ?? 'low';
    return { tier, medianMs, reason: `gpu ${medianMs.toFixed(2)} ms at ${probeTier}` };
  }

  if (medianMs <= targetMs * frameTolerance) {
    return { tier: probeTier, medianMs, reason: `frame ${medianMs.toFixed(2)} ms keeps up` };
  }
  const tier = highestTierWithin(medianMs, probeTier, targetMs * frameTolerance) ?? 'low';
  return { tier, medianMs, reason: `frame ${medianMs.toFixed(2)} ms at ${probeTier}` };
}
