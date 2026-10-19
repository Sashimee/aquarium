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
  /** Water light shafts: ray-marched in-scatter of the caustic pattern. */
  godRays: boolean;
  /** Blurs what is off the focal plane in focus mode. */
  depthOfField: boolean;
  causticMethod: CausticMethod;
  causticLayers: 1 | 2;
  /**
   * Resolution scale of the scene reflected under the water surface; 0 traces only the walls and
   * floor in the surface's shader.
   */
  surfaceReflection: number;
  /** Suspended particulates drifting in the water. */
  particleCount: number;
  /** Bubbles in the airstone column. */
  bubbleCount: number;
  fishLod: { midDistance: number; impostorDistance: number };
  plantDensity: number;
  textureSize: 1024 | 2048;
}

export const TIER_SETTINGS: Readonly<Record<Tier, Readonly<TierSettings>>> = {
  low: {
    resolutionScale: 1,
    maxPixelRatio: 1,
    shadowMapSize: 0,
    postChain: 'none',
    godRays: false,
    depthOfField: false,
    causticMethod: 'texture',
    causticLayers: 1,
    surfaceReflection: 0,
    particleCount: 150,
    bubbleCount: 12,
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
    depthOfField: true,
    causticMethod: 'procedural',
    causticLayers: 1,
    surfaceReflection: 0,
    particleCount: 400,
    bubbleCount: 24,
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
    depthOfField: true,
    causticMethod: 'procedural',
    causticLayers: 2,
    surfaceReflection: 0.5,
    particleCount: 900,
    bubbleCount: 40,
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
    depthOfField: true,
    causticMethod: 'procedural-dispersion',
    causticLayers: 2,
    surfaceReflection: 0.5,
    particleCount: 1600,
    bubbleCount: 64,
    fishLod: { midDistance: 2, impostorDistance: 5 },
    plantDensity: 1,
    textureSize: 2048,
  },
};

/**
 * Rough GPU cost of each tier relative to `high`, used to extrapolate a measured
 * frame time to the other tiers. Low's 0.35 assumed a 0.75 resolution scale; at full scale it
 * shades 1.78x the pixels, and with roughly 40% of its cost per pixel that makes 0.45, still
 * clear of medium, which shades as many pixels at DPR 1 and adds shadows, SMAA and procedural
 * caustics.
 */
export const TIER_COST: Readonly<Record<Tier, number>> = {
  low: 0.45,
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

/** The renderer pixel ratio for a tier: the device ratio clamped to the tier's cap, then scaled. */
export function renderPixelRatio(
  devicePixelRatio: number,
  settings: Pick<TierSettings, 'maxPixelRatio' | 'resolutionScale'>,
): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, settings.maxPixelRatio) * settings.resolutionScale;
}
