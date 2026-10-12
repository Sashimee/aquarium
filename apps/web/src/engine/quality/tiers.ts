export const TIERS = ['low', 'medium', 'high', 'ultra'] as const;

export type Tier = (typeof TIERS)[number];

export type TierChangeReason = 'probe' | 'over-budget' | 'headroom' | 'manual' | 'override';

export type CausticMethod = 'texture' | 'procedural' | 'procedural-dispersion';

export type PostChain = 'none' | 'smaa' | 'smaa-bloom' | 'taa-bloom';

export interface TierSettings {
  /** Multiplies the device pixel ratio after it is clamped to `maxPixelRatio`. */
  resolutionScale: number;
  maxPixelRatio: number;
  /** 0 disables shadow casting entirely. */
  shadowMapSize: number;
  postChain: PostChain;
  godRays: boolean;
  causticMethod: CausticMethod;
  causticLayers: 1 | 2;
  particleCount: number;
  fishLod: { midDistance: number; impostorDistance: number };
  plantDensity: number;
  textureSize: 1024 | 2048;
}

export const TIER_SETTINGS: Readonly<Record<Tier, Readonly<TierSettings>>> = {
  low: {
    resolutionScale: 0.75,
    maxPixelRatio: 1,
    shadowMapSize: 0,
    postChain: 'none',
    godRays: false,
    causticMethod: 'texture',
    causticLayers: 1,
    particleCount: 150,
    fishLod: { midDistance: 0.6, impostorDistance: 1.6 },
    plantDensity: 0.4,
    textureSize: 1024,
  },
  medium: {
    resolutionScale: 1,
    maxPixelRatio: 1.5,
    shadowMapSize: 1024,
    postChain: 'smaa',
    godRays: false,
    causticMethod: 'procedural',
    causticLayers: 1,
    particleCount: 400,
    fishLod: { midDistance: 0.9, impostorDistance: 2.4 },
    plantDensity: 0.7,
    textureSize: 1024,
  },
  high: {
    resolutionScale: 1,
    maxPixelRatio: 2,
    shadowMapSize: 2048,
    postChain: 'smaa-bloom',
    godRays: true,
    causticMethod: 'procedural',
    causticLayers: 2,
    particleCount: 900,
    fishLod: { midDistance: 1.4, impostorDistance: 3.5 },
    plantDensity: 1,
    textureSize: 2048,
  },
  ultra: {
    resolutionScale: 1,
    maxPixelRatio: 2,
    shadowMapSize: 4096,
    postChain: 'taa-bloom',
    godRays: true,
    causticMethod: 'procedural-dispersion',
    causticLayers: 2,
    particleCount: 1600,
    fishLod: { midDistance: 2, impostorDistance: 5 },
    plantDensity: 1,
    textureSize: 2048,
  },
};

/**
 * Rough GPU cost of each tier relative to `high`, used to extrapolate a measured
 * frame time to the other tiers.
 */
export const TIER_COST: Readonly<Record<Tier, number>> = {
  low: 0.35,
  medium: 0.6,
  high: 1,
  ultra: 1.7,
};

export function tierIndex(tier: Tier): number {
  return TIERS.indexOf(tier);
}

export function tierAt(index: number): Tier {
  const tier = TIERS[Math.min(TIERS.length - 1, Math.max(0, Math.trunc(index)))];
  if (tier === undefined) throw new RangeError(`tierAt: no tier for index ${index}`);
  return tier;
}

export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}
