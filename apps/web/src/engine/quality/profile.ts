import type { Tier } from './tiers';

/** How the quality system treats a class of device. */
export interface QualityProfile {
  /** Mean frame time adaptation aims under; it steps down at `targetMs * downRatio`. */
  targetMs: number;
  refreshMs: number;
  probeTier: Tier;
  maxTier: Tier;
}

const DISPLAY_MS = 1000 / 60;

export const DESKTOP_PROFILE: Readonly<QualityProfile> = {
  targetMs: DISPLAY_MS,
  refreshMs: DISPLAY_MS,
  probeTier: 'high',
  maxTier: 'ultra',
};

/**
 * PLAN §2.7: phones run the medium and low tiers and must hold 30 fps. With the controller's 1.2
 * down ratio, a 36 fps target steps down as soon as the mean frame drops under 30 fps. iOS Low
 * Power Mode caps the display at 30 fps, which sits on that line, so such a phone settles on low
 * whatever its GPU could do; read `?stats=1` numbers from it with that in mind.
 */
export const MOBILE_PROFILE: Readonly<QualityProfile> = {
  targetMs: 1000 / 36,
  refreshMs: DISPLAY_MS,
  probeTier: 'medium',
  maxTier: 'medium',
};

export function qualityProfile(coarsePointer: boolean): Readonly<QualityProfile> {
  return coarsePointer ? MOBILE_PROFILE : DESKTOP_PROFILE;
}
