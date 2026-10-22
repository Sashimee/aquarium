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
      frameCapFps: 60,
      pixelRatioCeiling: 1.5,
      maxTextureSize: 2048,
      textureBudgetMiB: { low: 44, medium: 44, high: 112, ultra: 112 },
    });
  });

  it('leaves phones uncapped in frame rate and pixel ratio ceiling', () => {
    expect(MOBILE_PROFILE.frameCapFps).toBeNull();
    expect(MOBILE_PROFILE.pixelRatioCeiling).toBe(Number.POSITIVE_INFINITY);
  });

  it('probes touch devices at medium and lets them climb to high but not ultra', () => {
    const mobile = qualityProfile(true);
    expect(mobile).toBe(MOBILE_PROFILE);
    expect(mobile.probeTier).toBe('medium');
    expect(mobile.maxTier).toBe('high');
  });

  it('keeps touch devices on 1k textures whatever the tier', () => {
    expect(MOBILE_PROFILE.maxTextureSize).toBe(1024);
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

  it('holds a high-density desktop at 1.5 on every tier unless the player opts out', () => {
    for (const tier of TIERS) {
      const capped = renderPixelRatio(2, TIER_SETTINGS[tier], DESKTOP_PROFILE.pixelRatioCeiling);
      expect(capped).toBeLessThanOrEqual(1.5);
    }
    expect(renderPixelRatio(2, TIER_SETTINGS.ultra, DESKTOP_PROFILE.pixelRatioCeiling)).toBe(1.5);
    expect(renderPixelRatio(2, TIER_SETTINGS.ultra, Number.POSITIVE_INFINITY)).toBe(2);
    expect(renderPixelRatio(3, TIER_SETTINGS.ultra, Number.POSITIVE_INFINITY)).toBe(2);
  });

  it('leaves desktop displays at or under the ceiling as they were', () => {
    const ceiling = DESKTOP_PROFILE.pixelRatioCeiling;
    expect(renderPixelRatio(1, TIER_SETTINGS.ultra, ceiling)).toBe(1);
    expect(renderPixelRatio(1.25, TIER_SETTINGS.high, ceiling)).toBe(1.25);
    expect(renderPixelRatio(1.5, TIER_SETTINGS.ultra, ceiling)).toBe(1.5);
    expect(renderPixelRatio(2, TIER_SETTINGS.low, ceiling)).toBe(1);
  });

  it('keeps phones at their tier caps, with no device class ceiling', () => {
    const ceiling = MOBILE_PROFILE.pixelRatioCeiling;
    expect(renderPixelRatio(3, TIER_SETTINGS.high, ceiling)).toBe(2);
    expect(renderPixelRatio(3, TIER_SETTINGS.medium, ceiling)).toBe(1.5);
  });

  it('never lets a ceiling push the ratio under one pixel per CSS pixel', () => {
    expect(renderPixelRatio(2, TIER_SETTINGS.high, 0.5)).toBe(1);
    expect(renderPixelRatio(2, TIER_SETTINGS.high, Number.NaN)).toBe(1);
  });

  it('treats a missing or invalid device ratio as 1', () => {
    expect(renderPixelRatio(0, TIER_SETTINGS.high)).toBe(1);
    expect(renderPixelRatio(Number.NaN, TIER_SETTINGS.high)).toBe(1);
  });
});
