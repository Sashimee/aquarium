import { describe, expect, it } from 'vitest';
import { featuresFor, sameFeatures } from './features';

describe('featuresFor', () => {
  it('dithers fins only while frames go through a temporal resolve', () => {
    expect(featuresFor('ultra', { msaa: false, temporal: true }).fins).toBe('stochastic');
    expect(featuresFor('high', { msaa: true, temporal: true }).fins).toBe('stochastic');
  });

  it('falls back to coverage on ultra when the resolve is not running and MSAA is on', () => {
    expect(featuresFor('ultra', { msaa: true, temporal: false }).fins).toBe('coverage');
  });

  it('falls back to the cutout without the resolve or MSAA', () => {
    expect(featuresFor('ultra', { msaa: false, temporal: false }).fins).toBe('cutout');
  });

  it('keeps the cutout on low even with MSAA', () => {
    expect(featuresFor('low', { msaa: true, temporal: false }).fins).toBe('cutout');
  });

  it('gates iridescence and clearcoat by tier alone', () => {
    const live = { msaa: true, temporal: false };
    expect(featuresFor('low', live)).toMatchObject({ iridescence: false, clearcoat: false });
    expect(featuresFor('medium', live)).toMatchObject({ iridescence: false, clearcoat: true });
    expect(featuresFor('high', live)).toMatchObject({ iridescence: true, clearcoat: true });
    expect(featuresFor('ultra', { msaa: false, temporal: true })).toMatchObject({
      iridescence: true,
      clearcoat: true,
    });
  });
});

describe('sameFeatures', () => {
  const ultra = featuresFor('ultra', { msaa: false, temporal: true });

  it('is false before any features were applied', () => {
    expect(sameFeatures(null, ultra)).toBe(false);
  });

  it('tells a change of fin rendering apart', () => {
    expect(sameFeatures(ultra, featuresFor('ultra', { msaa: false, temporal: true }))).toBe(true);
    expect(sameFeatures(ultra, featuresFor('ultra', { msaa: false, temporal: false }))).toBe(false);
  });
});
