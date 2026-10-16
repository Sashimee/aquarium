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
      gpuTiming: true,
    });
  });

  it('probes touch devices at medium and lets them climb to high but not ultra', () => {
    const mobile = qualityProfile(true);
    expect(mobile).toBe(MOBILE_PROFILE);
    expect(mobile.probeTier).toBe('medium');
    expect(mobile.maxTier).toBe('high');
  });

  it('adapts touch devices on frame time only', () => {
    expect(MOBILE_PROFILE.gpuTiming).toBe(false);
  });

  it('steps a phone down exactly when it falls under 30 fps', () => {
    const downAtMs = MOBILE_PROFILE.targetMs * DEFAULT_CONTROLLER_CONFIG.downRatio;
    expect(downAtMs).toBeCloseTo(1000 / 30, 6);
  });
});

describe('renderPixelRatio', () => {
  it('caps a 3x phone at 2 on high, 1.5 on medium and 1 on low', () => {
    expect(renderPixelRatio(3, TIER_SETTINGS.high)).toBe(2);
    expect(renderPixelRatio(3, TIER_SETTINGS.medium)).toBe(1.5);
    expect(renderPixelRatio(3, TIER_SETTINGS.low)).toBe(1);
  });

  it('renders every tier at no less than one pixel per CSS pixel on a high-density screen', () => {
    for (const dpr of [1, 2, 3]) {
      for (const tier of TIERS) {
        expect(renderPixelRatio(dpr, TIER_SETTINGS[tier])).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('never renders a phone above 2x on the tiers it can reach', () => {
    const reachable = TIERS.slice(0, tierIndex(MOBILE_PROFILE.maxTier) + 1);
    expect(reachable).toEqual(['low', 'medium', 'high']);
    for (const tier of reachable) {
      expect(renderPixelRatio(3, TIER_SETTINGS[tier])).toBeLessThanOrEqual(2);
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
