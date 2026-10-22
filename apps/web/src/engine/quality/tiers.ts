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
   * Resolution scale of the scene reflected under the water surface. Above 0 the side panes also
   * mirror the tank's contents from a copy of the frame; 0 traces only the walls and floor in the
   * surface's and the glass's shaders.
   */
  surfaceReflection: number;
  /** Suspended particulates drifting in the water. */
  particleCount: number;
  /** Bubbles in the airstone column. */
  bubbleCount: number;
  fishLod: { midDistance: number; impostorDistance: number };
  /**
   * Fish past `fishLod.impostorDistance` draw as octahedral impostors instead of their lod2 mesh,
   * and only the `fullMeshes` nearest draw as meshes at all (PLAN §9.1); null keeps every mesh.
   */
  fishImpostors: { readonly fullMeshes: number } | null;
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
    fishImpostors: { fullMeshes: 30 },
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
    fishImpostors: { fullMeshes: 30 },
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
    fishImpostors: null,
    plantDensity: 1,
    textureSize: 2048,
  },
  ultra: {
    resolutionScale: 1,
    maxPixelRatio: 2,
    // The hood's shadow frustum spans the tank, so 2048 texels are already under a millimetre on the
    // longest one; 4096 cost four times the depth writes and PCF taps for no visible edge.
    shadowMapSize: 2048,
    postChain: 'taa-bloom',
    godRays: true,
    depthOfField: true,
    causticMethod: 'procedural-dispersion',
    causticLayers: 2,
    surfaceReflection: 0.5,
    particleCount: 1600,
    bubbleCount: 64,
    fishLod: { midDistance: 2, impostorDistance: 5 },
    fishImpostors: null,
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
  // TODO(render-engineer): 1.7 predates ultra's trimmed shadows and half-res shafts (#1033), so it
  // overstates ultra; set it from measured high/ultra GPU times on real hardware (#1056).
  ultra: 1.7,
};

/**
 * The share of the frame budget a tier's GPU time may take. Ultra is a luxury over high, so it is
 * chosen, and kept, only while it leaves about half the GPU idle: a desktop GPU that could just
 * hold it would otherwise run flat out (#1020). Frame intervals cannot show that headroom, so
 * a tier with a share below 1 is reached only on GPU timing.
 */
export const TIER_GPU_SHARE: Readonly<Record<Tier, number>> = {
  low: 1,
  medium: 1,
  high: 1,
  ultra: 0.5,
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

export function lowerTier(a: Tier, b: Tier): Tier {
  return tierIndex(a) <= tierIndex(b) ? a : b;
}

/** The highest tier up to `maxTier` that frame intervals alone may choose. */
export function frameTimedMaxTier(maxTier: Tier): Tier {
  let tier = tierAt(0);
  for (const candidate of TIERS.slice(0, tierIndex(maxTier) + 1)) {
    if (TIER_GPU_SHARE[candidate] >= 1) tier = candidate;
  }
  return tier;
}

/**
 * The renderer pixel ratio for a tier: the device ratio clamped to the tier's cap and to the
 * device class's `ceiling`, then scaled.
 */
export function renderPixelRatio(
  devicePixelRatio: number,
  settings: Pick<TierSettings, 'maxPixelRatio' | 'resolutionScale'>,
  ceiling = Number.POSITIVE_INFINITY,
): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const cap = ceiling >= 1 ? ceiling : 1;
  return Math.min(dpr, settings.maxPixelRatio, cap) * settings.resolutionScale;
}
