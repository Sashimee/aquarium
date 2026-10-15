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
  swimModeFor,
} from './profiles';
import { SWIM_MODES } from './swim';

const contentFiles = import.meta.glob<unknown>(
  ['../../../../content/species/*.json', '../../../../content/species-pending/*.json'],
  { eager: true, import: 'default' },
);

interface ContentSpecies {
  readonly id: string;
  readonly locomotion: { readonly swimmingMode: string };
}

function isContentSpecies(raw: unknown): raw is ContentSpecies {
  if (typeof raw !== 'object' || raw === null || !('id' in raw) || !('locomotion' in raw)) {
    return false;
  }
  const { id, locomotion } = raw;
  return (
    typeof id === 'string' &&
    typeof locomotion === 'object' &&
    locomotion !== null &&
    'swimmingMode' in locomotion &&
    typeof locomotion.swimmingMode === 'string'
  );
}

const keys = (n: number): string[] => Array.from({ length: n }, (_, i) => `fish-${i}`);
const demo = (key: string) => ({ key, sex: null });
const MALE = { key: 'guppy-2', sex: 'male' } as const;
const FEMALE = { key: 'guppy-0', sex: 'female' } as const;
const DEMO_MALE = 'guppy-0';
const DEMO_FEMALE = 'guppy-2';

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
      bodyLengthOf({ ...demo(DEMO_MALE), species: 'guppy', lengthM: 0.04 }, 0.027),
    ).toBeCloseTo(0.025);
    expect(bodyLengthOf({ ...demo(DEMO_FEMALE), species: 'guppy', lengthM: 0.04 }, 0.027)).toBe(
      0.04,
    );
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

describe('render profile coverage', () => {
  const species = Object.entries(contentFiles).map(([path, raw]) => {
    if (!isContentSpecies(raw)) throw new Error(`${path} has no id or swimming mode`);
    return raw;
  });

  it('reads both the live and the pending species', () => {
    const ids = species.map((s) => s.id);
    expect(ids).toContain('neon-tetra');
    expect(ids).toContain('firefish');
    expect(ids).toContain('cherry-shrimp');
  });

  it('has a profile for every species, live or pending, walkers included', () => {
    for (const { id } of species) expect(() => renderProfile(id), id).not.toThrow();
  });

  it('gives no species a profile for a model of another kind', () => {
    for (const { id, locomotion } of species) {
      const walker = locomotion.swimmingMode === 'pleopod';
      expect(renderProfile(id).assetId.endsWith('shrimp'), id).toBe(walker);
    }
  });

  it('names an unknown species when it has no profile', () => {
    expect(() => renderProfile('mystery-fish')).toThrow(/"mystery-fish"/);
  });
});

describe('swimModeFor', () => {
  it('leaves a species without swim tuning on its mode', () => {
    expect(swimModeFor(SWIM_MODES.carangiform, renderProfile('neon-tetra'))).toEqual(
      SWIM_MODES.carangiform,
    );
  });

  it('scales only the amplitudes', () => {
    const mode = SWIM_MODES.labriform;
    const discus = renderProfile('discus');
    const tuned = swimModeFor(mode, discus);
    expect(tuned.bodyWave).toBeCloseTo(mode.bodyWave * discus.swim.bodyWave);
    expect(tuned.pectoral).toBeCloseTo(mode.pectoral * discus.swim.pectoral);
    expect(tuned.medianFin).toBeCloseTo(mode.medianFin * discus.swim.medianFin);
    expect(tuned.envelope).toBe(mode.envelope);
    expect(tuned.wavelength).toBe(mode.wavelength);
    expect(tuned.pectoralIdleHz).toBe(mode.pectoralIdleHz);
  });

  it('keeps the discus body stiffer than a plain labriform swimmer, and the pleco fins stiffer', () => {
    expect(renderProfile('discus').swim.bodyWave).toBeLessThan(1);
    expect(renderProfile('discus').swim.medianFin).toBeGreaterThan(1);
    const pleco = renderProfile('bristlenose-pleco').swim;
    expect(Math.max(pleco.bodyWave, pleco.pectoral, pleco.medianFin)).toBeLessThan(1);
  });

  it('gives every profile positive swim scales', () => {
    for (const [id, { swim }] of Object.entries(FISH_RENDER_PROFILES)) {
      for (const scale of [swim.bodyWave, swim.pectoral, swim.medianFin]) {
        expect(scale, id).toBeGreaterThan(0);
      }
    }
  });
});
