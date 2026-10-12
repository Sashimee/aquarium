import { describe, expect, it } from 'vitest';
import { median, selectInitialTier } from './probe';

const TARGET = 1000 / 60;

describe('median', () => {
  it('returns null when there are no usable samples', () => {
    expect(median([])).toBeNull();
    expect(median([0, -1, Number.NaN, Number.POSITIVE_INFINITY])).toBeNull();
  });

  it('handles odd and even counts and ignores invalid samples', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7, Number.NaN, 0])).toBe(7);
  });
});

describe('selectInitialTier', () => {
  it('falls back to medium without samples', () => {
    const r = selectInitialTier({
      samples: [],
      signal: 'gpu',
      probeTier: 'high',
      targetMs: TARGET,
    });
    expect(r).toMatchObject({ tier: 'medium', medianMs: null });
  });

  it('extrapolates gpu timings to the highest tier inside the headroom', () => {
    const pick = (ms: number) =>
      selectInitialTier({
        samples: [ms, ms, ms],
        signal: 'gpu',
        probeTier: 'high',
        targetMs: TARGET,
      }).tier;
    // Budget 0.8 x 16.67 = 13.33 ms; tier costs relative to high: 0.35, 0.6, 1, 1.7.
    expect(pick(5)).toBe('ultra');
    expect(pick(7.84)).toBe('ultra');
    expect(pick(8)).toBe('high');
    expect(pick(13.3)).toBe('high');
    expect(pick(14)).toBe('medium');
    expect(pick(30)).toBe('low');
    expect(pick(200)).toBe('low');
  });

  it('is robust to outliers in the probe window', () => {
    const r = selectInitialTier({
      samples: [5, 5, 5, 5, 240, 5, 5],
      signal: 'gpu',
      probeTier: 'high',
      targetMs: TARGET,
    });
    expect(r.tier).toBe('ultra');
  });

  it('keeps the probe tier when vsync-bound frames keep up, without guessing higher', () => {
    const r = selectInitialTier({
      samples: Array(60).fill(TARGET),
      signal: 'frame',
      probeTier: 'high',
      targetMs: TARGET,
    });
    expect(r.tier).toBe('high');
  });

  it('steps down from frame intervals that miss the target', () => {
    const pick = (ms: number) =>
      selectInitialTier({ samples: [ms], signal: 'frame', probeTier: 'high', targetMs: TARGET })
        .tier;
    expect(pick(1000 / 30)).toBe('low');
    expect(pick(25)).toBe('medium');
  });

  it('respects custom headroom and tolerance', () => {
    expect(
      selectInitialTier({
        samples: [15],
        signal: 'gpu',
        probeTier: 'high',
        targetMs: TARGET,
        gpuHeadroom: 0.5,
      }).tier,
    ).toBe('low');
    expect(
      selectInitialTier({
        samples: [20],
        signal: 'frame',
        probeTier: 'medium',
        targetMs: TARGET,
        frameTolerance: 1.25,
      }).tier,
    ).toBe('medium');
  });
});
