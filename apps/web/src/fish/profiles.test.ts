import { describe, expect, it } from 'vitest';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import { demoTank } from './demoStock';
import { assetIdFor, batchKeyOf, FISH_RENDER_PROFILES, renderProfile } from './profiles';

const keys = (n: number): string[] => Array.from({ length: n }, (_, i) => `fish-${i}`);

describe('assetIdFor', () => {
  it('always gives a species without variants its one model', () => {
    const neon = renderProfile('neon-tetra');
    for (const key of keys(50)) expect(assetIdFor(neon, key)).toBe('neon-tetra');
  });

  it('gives a fish the same model on every call, so a reload keeps its sex', () => {
    const guppy = renderProfile('guppy');
    for (const key of keys(50)) expect(assetIdFor(guppy, key)).toBe(assetIdFor(guppy, key));
  });

  it('draws the guppy male for about half the fish', () => {
    const guppy = renderProfile('guppy');
    const males = keys(2000).filter((k) => assetIdFor(guppy, k) === 'guppy-male').length;
    expect(males / 2000).toBeGreaterThan(0.4);
    expect(males / 2000).toBeLessThan(0.6);
  });

  it('never gives out more than the whole of a species', () => {
    for (const [id, profile] of Object.entries(FISH_RENDER_PROFILES)) {
      const total = profile.variants.reduce((sum, v) => sum + v.share, 0);
      expect(total, id).toBeLessThanOrEqual(1);
      for (const v of profile.variants) expect(v.share, id).toBeGreaterThan(0);
    }
  });
});

describe('batchKeyOf', () => {
  it('splits a species by model and keeps species apart', () => {
    const guppy = renderProfile('guppy');
    const male = keys(50).find((k) => assetIdFor(guppy, k) === 'guppy-male');
    const female = keys(50).find((k) => assetIdFor(guppy, k) === 'guppy-female');
    if (male === undefined || female === undefined) throw new Error('no guppy of each sex');
    expect(batchKeyOf({ species: 'guppy', key: male })).toBe('guppy/guppy-male');
    expect(batchKeyOf({ species: 'guppy', key: female })).toBe('guppy/guppy-female');
    expect(batchKeyOf({ species: 'angelfish', key: male })).toBe('angelfish/angelfish');
  });

  it('keys a species with no profile by species alone', () => {
    expect(batchKeyOf({ species: 'mystery-fish', key: 'a' })).toBe('mystery-fish/');
  });
});

describe('the freshwater demo', () => {
  it('shows male and female guppies', () => {
    const { config } = demoTank(DEFAULT_TANK, 1, 'freshwater');
    const guppy = renderProfile('guppy');
    const models = new Set(
      config.fish.filter((f) => f.species === 'guppy').map((f) => assetIdFor(guppy, f.id)),
    );
    expect(models).toEqual(new Set(['guppy-male', 'guppy-female']));
  });
});
