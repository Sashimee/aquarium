import type { Tier } from '../engine/quality/tiers';
import type { FinRendering, FishMaterialFeatures } from './material';

export interface FeatureContext {
  /** The canvas has MSAA, which the engine only enables below DPR 2. */
  readonly msaa: boolean;
  /** Frames go through a temporal resolve now, not merely on a tier that would have one. */
  readonly temporal: boolean;
}

/**
 * Translucent fins dither under the temporal resolve, which averages the pattern into a blend.
 * Elsewhere they use alpha-to-coverage, which needs MSAA; without it they fall back to the cutout.
 */
export function featuresFor(tier: Tier, { msaa, temporal }: FeatureContext): FishMaterialFeatures {
  const fins: FinRendering = temporal
    ? 'stochastic'
    : tier !== 'low' && msaa
      ? 'coverage'
      : 'cutout';
  return {
    fins,
    iridescence: tier === 'high' || tier === 'ultra',
    clearcoat: tier !== 'low',
  };
}

export function sameFeatures(a: FishMaterialFeatures | null, b: FishMaterialFeatures): boolean {
  return (
    a !== null &&
    a.fins === b.fins &&
    a.iridescence === b.iridescence &&
    a.clearcoat === b.clearcoat
  );
}
