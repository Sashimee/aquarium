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
}

const DISPLAY_MS = 1000 / 60;

export const DESKTOP_PROFILE: Readonly<QualityProfile> = {
  targetMs: DISPLAY_MS,
  refreshMs: DISPLAY_MS,
  probeTier: 'high',
  maxTier: 'ultra',
  gpuTiming: true,
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
 */
export const MOBILE_PROFILE: Readonly<QualityProfile> = {
  targetMs: 1000 / 36,
  refreshMs: DISPLAY_MS,
  probeTier: 'medium',
  maxTier: 'high',
  gpuTiming: false,
};

export function qualityProfile(coarsePointer: boolean): Readonly<QualityProfile> {
  return coarsePointer ? MOBILE_PROFILE : DESKTOP_PROFILE;
}
