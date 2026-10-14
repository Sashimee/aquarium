import { describe, expect, it } from 'vitest';
import { DEFAULT_TANK } from '../engine/tank/dimensions';
import { demoTank } from './demoStock';
import {
  batchKeyOf,
  bodyLengthOf,
  FISH_RENDER_PROFILES,
  modelFor,
  renderProfile,
  sexOf,
} from './profiles';

const keys = (n: number): string[] => Array.from({ length: n }, (_, i) => `fish-${i}`);

describe('sexOf', () => {
  it('keeps the sex every saved and demo fish was first given', () => {
    const pinned: Readonly<Record<string, 'male' | 'female'>> = {
      'guppy-0': 'male',
      'guppy-1': 'male',
      'guppy-2': 'female',
      'guppy-3': 'female',
      '0b7c1e7a-3f0e-4c5d-9a51-2f4d8e6b1c90': 'female',
      '5f3d2a10-8e4b-4f6a-b7c2-1d9e0a3b4c5d': 'male',
    };
    for (const [key, sex] of Object.entries(pinned)) expect(sexOf(key), key).toBe(sex);
  });

  it('is about 1:1', () => {
    const males = keys(2000).filter((k) => sexOf(k) === 'male').length;
    expect(males / 2000).toBeGreaterThan(0.45);
    expect(males / 2000).toBeLessThan(0.55);
  });
});

describe('modelFor', () => {
  it('always gives a species without a male model its one model at full length', () => {
    const neon = renderProfile('neon-tetra');
    for (const key of keys(50)) {
      expect(modelFor(neon, key)).toEqual({ assetId: 'neon-tetra', lengthFactor: 1 });
    }
  });

  it('draws male guppies with the smaller male model and females with the species one', () => {
    const guppy = renderProfile('guppy');
    for (const key of keys(50)) {
      const model = modelFor(guppy, key);
      if (sexOf(key) === 'male') {
        expect(model).toEqual({ assetId: 'guppy-male', lengthFactor: 0.625 });
      } else {
        expect(model).toEqual({ assetId: 'guppy-female', lengthFactor: 1 });
      }
    }
  });

  it('gives every male model a length factor in (0, 1]', () => {
    for (const [id, profile] of Object.entries(FISH_RENDER_PROFILES)) {
      if (profile.male === null) continue;
      expect(profile.male.lengthFactor, id).toBeGreaterThan(0);
      expect(profile.male.lengthFactor, id).toBeLessThanOrEqual(1);
    }
  });
});

describe('bodyLengthOf', () => {
  const male = keys(50).find((k) => sexOf(k) === 'male');
  const female = keys(50).find((k) => sexOf(k) === 'female');
  if (male === undefined || female === undefined) throw new Error('no key of each sex');

  it('scales a male guppy below its size, and leaves a female at it', () => {
    expect(bodyLengthOf({ species: 'guppy', key: male, lengthM: 0.04 }, 0.027)).toBeCloseTo(0.025);
    expect(bodyLengthOf({ species: 'guppy', key: female, lengthM: 0.04 }, 0.027)).toBe(0.04);
  });

  it('falls back to the species length when the fish has no size', () => {
    expect(bodyLengthOf({ species: 'guppy', key: male, lengthM: undefined }, 0.027)).toBeCloseTo(
      0.016875,
    );
    expect(bodyLengthOf({ species: 'neon-tetra', key: male, lengthM: undefined }, 0.03)).toBe(0.03);
  });

  it('leaves a species with no profile at its size', () => {
    expect(bodyLengthOf({ species: 'mystery-fish', key: male, lengthM: 0.1 }, 0.2)).toBe(0.1);
  });
});

describe('batchKeyOf', () => {
  it('splits a species by model and keeps species apart', () => {
    const male = keys(50).find((k) => sexOf(k) === 'male');
    const female = keys(50).find((k) => sexOf(k) === 'female');
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
      config.fish.filter((f) => f.species === 'guppy').map((f) => modelFor(guppy, f.id).assetId),
    );
    expect(models).toEqual(new Set(['guppy-male', 'guppy-female']));
  });
});
