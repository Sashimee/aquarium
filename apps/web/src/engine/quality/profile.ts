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
  /** Caps every tier's `textureSize`, a pinned or manual tier included: memory is not frame time. */
  maxTextureSize: 1024 | 2048;
  /**
   * Decoded GPU bytes, in MiB, that the textures of a demo tank may take at each tier: model,
   * substrate, fish and impostor maps plus the backdrop, mips included, once KTX2 is transcoded to
   * a block-compressed format. `textureBudget.test.ts` holds every preset to it.
   */
  textureBudgetMiB: Readonly<Record<Tier, number>>;
}

const DISPLAY_MS = 1000 / 60;

export const DESKTOP_PROFILE: Readonly<QualityProfile> = {
  targetMs: DISPLAY_MS,
  refreshMs: DISPLAY_MS,
  probeTier: 'high',
  maxTier: 'ultra',
  gpuTiming: true,
  maxTextureSize: 2048,
  textureBudgetMiB: { low: 44, medium: 44, high: 112, ultra: 112 },
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
  maxTextureSize: 1024,
  textureBudgetMiB: { low: 44, medium: 44, high: 48, ultra: 48 },
};

export function qualityProfile(coarsePointer: boolean): Readonly<QualityProfile> {
  return coarsePointer ? MOBILE_PROFILE : DESKTOP_PROFILE;
}
