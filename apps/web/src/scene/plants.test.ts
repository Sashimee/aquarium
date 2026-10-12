import { describe, expect, it } from 'vitest';
import { TIER_SETTINGS } from '../engine/quality/tiers';
import { maxSway, visibleAtDensity } from './plants';

describe('visibleAtDensity', () => {
  const ranked = Array.from({ length: 20 }, (_, i) => ({ rank: i / 20 }));
  const layout = [{ rank: -1 }, { rank: -1 }];

  it('thins patches per tier and never adds plants on a lower tier', () => {
    const counts = (['low', 'medium', 'high', 'ultra'] as const).map((tier) =>
      visibleAtDensity(ranked, TIER_SETTINGS[tier].plantDensity),
    );
    expect(counts).toEqual([8, 14, 20, 20]);
    expect([...counts].sort((a, b) => a - b)).toEqual(counts);
  });

  it('always shows layout plants', () => {
    expect(visibleAtDensity(layout, 0)).toBe(2);
    expect(visibleAtDensity([...ranked, ...layout], 0.4)).toBe(10);
  });

  it('shows nothing at zero density', () => {
    expect(visibleAtDensity(ranked, 0)).toBe(0);
  });
});

describe('maxSway', () => {
  const current = { direction: [1, 0] as const, speed: 0.05, gustPeriodS: 8, gustDepth: 0.45 };

  it('grows with plant height and current speed', () => {
    expect(maxSway('vallisneria', 0.4, current)).toBeGreaterThan(
      maxSway('vallisneria', 0.2, current),
    );
    expect(maxSway('vallisneria', 0.3, { ...current, speed: 0.1 })).toBeGreaterThan(
      maxSway('vallisneria', 0.3, current),
    );
  });

  it('is smaller for stiff plants', () => {
    expect(maxSway('java-fern', 0.3, current)).toBeLessThan(maxSway('vallisneria', 0.3, current));
  });
});
