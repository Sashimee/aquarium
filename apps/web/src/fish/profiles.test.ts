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
const demo = (key: string) => ({ key, sex: null });
const MALE = { key: 'guppy-2', sex: 'male' } as const;
const FEMALE = { key: 'guppy-0', sex: 'female' } as const;

describe('sexOf', () => {
  it('reads the sex the server stored, whatever the key would draw', () => {
    expect(sexOf(MALE)).toBe('male');
    expect(sexOf(FEMALE)).toBe('female');
    expect(sexOf(demo(MALE.key))).toBe('female');
    expect(sexOf(demo(FEMALE.key))).toBe('male');
  });

  it('draws a demo fish the sex the server backfilled saved fish with', () => {
    const pinned: Readonly<Record<string, 'male' | 'female'>> = {
      'guppy-0': 'male',
      'guppy-1': 'male',
      'guppy-2': 'female',
      'guppy-3': 'female',
      '0b7c1e7a-3f0e-4c5d-9a51-2f4d8e6b1c90': 'female',
      '5f3d2a10-8e4b-4f6a-b7c2-1d9e0a3b4c5d': 'male',
    };
    for (const [key, sex] of Object.entries(pinned)) expect(sexOf(demo(key)), key).toBe(sex);
  });

  it('is about 1:1', () => {
    const males = keys(2000).filter((k) => sexOf(demo(k)) === 'male').length;
    expect(males / 2000).toBeGreaterThan(0.45);
    expect(males / 2000).toBeLessThan(0.55);
  });
});

describe('modelFor', () => {
  it('always gives a species without a male model its one model at full length', () => {
    const neon = renderProfile('neon-tetra');
    for (const key of keys(50)) {
      expect(modelFor(neon, demo(key))).toEqual({ assetId: 'neon-tetra', lengthFactor: 1 });
    }
    expect(modelFor(neon, MALE)).toEqual({ assetId: 'neon-tetra', lengthFactor: 1 });
  });

  it('draws a saved guppy as the sex the server stored', () => {
    const guppy = renderProfile('guppy');
    expect(modelFor(guppy, MALE)).toEqual({ assetId: 'guppy-male', lengthFactor: 0.625 });
    expect(modelFor(guppy, FEMALE)).toEqual({ assetId: 'guppy-female', lengthFactor: 1 });
  });

  it('draws demo guppies by the sex their key draws', () => {
    const guppy = renderProfile('guppy');
    for (const key of keys(50)) {
      const model = modelFor(guppy, demo(key));
      if (sexOf(demo(key)) === 'male') {
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
  it('scales a male guppy below its size, and leaves a female at it', () => {
    expect(bodyLengthOf({ ...MALE, species: 'guppy', lengthM: 0.04 }, 0.027)).toBeCloseTo(0.025);
    expect(bodyLengthOf({ ...FEMALE, species: 'guppy', lengthM: 0.04 }, 0.027)).toBe(0.04);
  });

  it('sizes a demo guppy by the sex its key draws', () => {
    expect(
      bodyLengthOf({ ...demo(FEMALE.key), species: 'guppy', lengthM: 0.04 }, 0.027),
    ).toBeCloseTo(0.025);
    expect(bodyLengthOf({ ...demo(MALE.key), species: 'guppy', lengthM: 0.04 }, 0.027)).toBe(0.04);
  });

  it('falls back to the species length when the fish has no size', () => {
    expect(bodyLengthOf({ ...MALE, species: 'guppy', lengthM: undefined }, 0.027)).toBeCloseTo(
      0.016875,
    );
    expect(bodyLengthOf({ ...MALE, species: 'neon-tetra', lengthM: undefined }, 0.03)).toBe(0.03);
  });

  it('leaves a species with no profile at its size', () => {
    expect(bodyLengthOf({ ...MALE, species: 'mystery-fish', lengthM: 0.1 }, 0.2)).toBe(0.1);
  });
});

describe('batchKeyOf', () => {
  it('splits a species by model and keeps species apart', () => {
    expect(batchKeyOf({ ...MALE, species: 'guppy' })).toBe('guppy/guppy-male');
    expect(batchKeyOf({ ...FEMALE, species: 'guppy' })).toBe('guppy/guppy-female');
    expect(batchKeyOf({ ...MALE, species: 'angelfish' })).toBe('angelfish/angelfish');
  });

  it('keys a species with no profile by species alone', () => {
    expect(batchKeyOf({ ...demo('a'), species: 'mystery-fish' })).toBe('mystery-fish/');
  });
});

describe('the freshwater demo', () => {
  it('shows male and female guppies', () => {
    const { config } = demoTank(DEFAULT_TANK, 1, 'freshwater');
    const guppy = renderProfile('guppy');
    const models = new Set(
      config.fish
        .filter((f) => f.species === 'guppy')
        .map((f) => modelFor(guppy, demo(f.id)).assetId),
    );
    expect(models).toEqual(new Set(['guppy-male', 'guppy-female']));
  });
});
