import type { Tier } from './tiers';

/** How the quality system treats a class of device. */
export interface QualityProfile {
  /** Mean frame time adaptation aims under; it steps down at `targetMs * downRatio`. */
  targetMs: number;
  refreshMs: number;
  probeTier: Tier;
  maxTier: Tier;
  /** Whether the probe and adaptation may read GPU timestamps; false adapts on frame time only. */
  gpuTiming: boolean;
  /** Frames drawn per second at most, whatever the display's rate; null draws every display frame. */
  frameCapFps: number | null;
  /** The render pixel ratio never exceeds this, on any tier, unless the player asks for more. */
  pixelRatioCeiling: number;
  /** Caps every tier's `textureSize`, a pinned or manual tier included: memory is not frame time. */
  maxTextureSize: 1024 | 2048;
  /**
   * Decoded GPU bytes, in MiB, that the textures of a tank may take at each tier: model,
   * substrate, fish and impostor maps plus the backdrop, mips included, once KTX2 is transcoded to
   * the device class's worst block-compressed format: ETC2 on a phone, BC7 on a desktop, where
   * ETC1S takes twice the bytes. `textureBudget.test.ts` holds every preset to it, stocked with its
   * demo and with every species of its biome.
   */
  textureBudgetMiB: Readonly<Record<Tier, number>>;
}

const DISPLAY_MS = 1000 / 60;

/**
 * A tank needs no more than 60 fps, and on a 120-165 Hz monitor drawing every display frame ran a
 * desktop GPU two to three times as hard for nothing (#1020). At a device ratio of 2, 1.5 shades
 * 56% of the pixels, and TRAA or SMAA hides the difference at viewing distance.
 *
 * Low and medium load the phone's 1k set, so their budget is the phone's 44 MiB carried over to
 * BC7: a tank holding every freshwater species takes 43.6 MiB as ETC on a phone and 59.5 MiB as
 * BC7, the same maps, so 60 (#1338). A desktop has no iOS tab limit of its own to set it lower.
 */
export const DESKTOP_PROFILE: Readonly<QualityProfile> = {
  targetMs: DISPLAY_MS,
  refreshMs: DISPLAY_MS,
  probeTier: 'high',
  maxTier: 'ultra',
  gpuTiming: true,
  frameCapFps: 60,
  pixelRatioCeiling: 1.5,
  maxTextureSize: 2048,
  textureBudgetMiB: { low: 60, medium: 60, high: 156, ultra: 156 },
};

/**
 * PLAN §2.7: phones must hold 30 fps. With the controller's 1.2 down ratio, a 36 fps target steps
 * down as soon as the mean frame drops under 30 fps. They probe at medium and climb to high only
 * after holding the display rate there (an iPhone 15 Pro at dpr 3 holds 60 fps on high); ultra's
 * TRAA and 4k shadows stay desktop-only. iOS Low Power Mode caps the display at 30 fps, which
 * sits on that line, so such a phone settles on low whatever its GPU could do; read `?stats=1`
 * numbers from it with that in mind.
 *
 * Adaptation reads frame time only: on iOS the summed render-pass timestamps read 23-56 ms on a
 * phone holding 60 fps, so they are not a per-frame GPU cost there.
 *
 * Phones keep 1k maps on every tier (#1019). The 2k set of the freshwater demo is about 103 MiB
 * against 42 MiB at 1k, and a climb from medium briefly holds both while the new set loads, on top
 * of high's roughly 110 MiB of render targets at dpr 2: an iPhone froze and went black on it.
 */
export const MOBILE_PROFILE: Readonly<QualityProfile> = {
  targetMs: 1000 / 36,
  refreshMs: DISPLAY_MS,
  probeTier: 'medium',
  maxTier: 'high',
  gpuTiming: false,
  frameCapFps: null,
  pixelRatioCeiling: Number.POSITIVE_INFINITY,
  maxTextureSize: 1024,
  textureBudgetMiB: { low: 44, medium: 44, high: 48, ultra: 48 },
};

export interface PointerEnvironment {
  /** `(pointer: coarse)`: the primary pointer is a finger. */
  readonly coarsePointer: boolean;
  readonly platform: string;
  readonly maxTouchPoints: number;
}

/**
 * An iPad with a trackpad or mouse reports a fine primary pointer, but it has an iPad's memory.
 * iPadOS calls itself MacIntel, and no Mac has a touch screen. `any-pointer: coarse` or touch points
 * alone would also take in Windows touch laptops, which have a desktop GPU.
 */
export function isTouchFirst(env: PointerEnvironment): boolean {
  return env.coarsePointer || (env.platform === 'MacIntel' && env.maxTouchPoints > 1);
}

export function qualityProfile(coarsePointer: boolean): Readonly<QualityProfile> {
  return coarsePointer ? MOBILE_PROFILE : DESKTOP_PROFILE;
}
