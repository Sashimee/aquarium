import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTROLLER_CONFIG } from './controller';
import { DESKTOP_PROFILE, MOBILE_PROFILE, qualityProfile } from './profile';
import { renderPixelRatio, TIER_SETTINGS, TIERS, tierIndex } from './tiers';

describe('qualityProfile', () => {
  it('keeps desktop on the 60 fps target with every tier available', () => {
    expect(qualityProfile(false)).toBe(DESKTOP_PROFILE);
    expect(DESKTOP_PROFILE).toEqual({
      targetMs: 1000 / 60,
      refreshMs: 1000 / 60,
      probeTier: 'high',
      maxTier: 'ultra',
    });
  });

  it('limits touch devices to the medium and low tiers of the mobile budget', () => {
    const mobile = qualityProfile(true);
    expect(mobile).toBe(MOBILE_PROFILE);
    expect(mobile.maxTier).toBe('medium');
    expect(tierIndex(mobile.probeTier)).toBeLessThanOrEqual(tierIndex(mobile.maxTier));
  });

  it('steps a phone down exactly when it falls under 30 fps', () => {
    const downAtMs = MOBILE_PROFILE.targetMs * DEFAULT_CONTROLLER_CONFIG.downRatio;
    expect(downAtMs).toBeCloseTo(1000 / 30, 6);
  });
});

describe('renderPixelRatio', () => {
  it('caps a 3x phone at 1.5 on medium and 0.75 on low', () => {
    expect(renderPixelRatio(3, TIER_SETTINGS.medium)).toBe(1.5);
    expect(renderPixelRatio(3, TIER_SETTINGS.low)).toBe(0.75);
  });

  it('never renders a phone above 1.5x on the tiers it can reach', () => {
    const reachable = TIERS.slice(0, tierIndex(MOBILE_PROFILE.maxTier) + 1);
    for (const tier of reachable) {
      expect(renderPixelRatio(3, TIER_SETTINGS[tier])).toBeLessThanOrEqual(1.5);
    }
  });

  it('leaves desktop displays as they were', () => {
    expect(renderPixelRatio(1, TIER_SETTINGS.high)).toBe(1);
    expect(renderPixelRatio(2, TIER_SETTINGS.ultra)).toBe(2);
    expect(renderPixelRatio(1.25, TIER_SETTINGS.medium)).toBe(1.25);
  });

  it('treats a missing or invalid device ratio as 1', () => {
    expect(renderPixelRatio(0, TIER_SETTINGS.high)).toBe(1);
    expect(renderPixelRatio(Number.NaN, TIER_SETTINGS.high)).toBe(1);
  });
});
