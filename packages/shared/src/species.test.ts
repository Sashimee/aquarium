import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { behaviourSchema, checkSpeciesRules, speciesSchema, traitSchema } from './species.js';

const dir = join(import.meta.dirname, '../../../content/species');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const contentSchema = speciesSchema.partial({ render: true });

describe('content/species', () => {
  it('has species files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s passes the shared schema', (file) => {
    const raw: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    expect(contentSchema.safeParse(raw).error).toBeUndefined();
  });
});

describe('behaviour traits', () => {
  const base = JSON.parse(readFileSync(join(dir, 'neon-tetra.json'), 'utf8')) as {
    behaviour: Record<string, unknown>;
  };

  it('rejects a mistyped trait', () => {
    const r = behaviourSchema.safeParse({ ...base.behaviour, traits: ['rock-grazr'] });
    expect(r.success).toBe(false);
  });

  it('accepts every known trait', () => {
    for (const t of traitSchema.options) {
      expect(behaviourSchema.safeParse({ ...base.behaviour, traits: [t] }).success).toBe(true);
    }
  });

  it('accepts per-trait parameters and keeps them optional', () => {
    const r = behaviourSchema.safeParse({
      ...base.behaviour,
      traits: ['air-gulp', 'rock-grazer'],
      airGulp: { perHour: 4 },
      grazing: { meanIntervalS: 30, minS: 1, maxS: 3 },
      flare: { minS: 2, maxS: 5 },
      station: { radiusBodyLengths: 2 },
      refuge: { afterStartleS: 30 },
      excursion: { meanIntervalS: 20 },
    });
    expect(r.error).toBeUndefined();
  });

  it('rejects out-of-range parameters and unknown keys', () => {
    const bad = [
      { airGulp: { perHour: 0 } },
      { grazing: { meanIntervalS: 10, minS: 5, maxS: 2 } },
      { flare: { minS: 6, maxS: 2 } },
      { station: { radiusBodyLengths: 1, restationMinS: 90, restationMaxS: 30 } },
      { airGulp: { perHour: 3, extra: 1 } },
    ];
    for (const extra of bad) {
      expect(behaviourSchema.safeParse({ ...base.behaviour, ...extra }).success).toBe(false);
    }
  });
});

describe('walking invertebrates', () => {
  const tetra = JSON.parse(readFileSync(join(dir, 'neon-tetra.json'), 'utf8')) as {
    behaviour: { traits: string[] };
    locomotion: Record<string, unknown>;
  };
  const walking = {
    walkSpeedMps: 0.01,
    strideBodyLengths: 0.3,
    legPairs: 5,
    surfaces: ['substrate', 'decor'],
    tailFlip: { speedMps: 0.4, durationS: 0.2, refractoryS: 3 },
  };
  const shrimp = (
    loco: Record<string, unknown> = {},
    traits: string[] = ['biofilm-grazer'],
  ): unknown => ({
    ...tetra,
    behaviour: { ...tetra.behaviour, traits },
    locomotion: { ...tetra.locomotion, swimmingMode: 'pleopod', walking, ...loco },
  });
  const ok = (v: unknown): boolean =>
    contentSchema.superRefine(checkSpeciesRules).safeParse(v).success;
  const withWalking = (patch: Record<string, unknown>): unknown =>
    shrimp({ walking: { ...walking, ...patch } });

  it('accepts a walker and the new traits', () => {
    expect(ok(shrimp())).toBe(true);
    expect(ok(shrimp({}, ['cleaner']))).toBe(true);
  });

  it('keeps shipped species valid under the checked rules', () => {
    for (const f of files) {
      const raw: unknown = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const r = contentSchema.superRefine(checkSpeciesRules).safeParse(raw);
      expect(r.error).toBeUndefined();
    }
  });

  it('requires walking exactly when swimmingMode is pleopod', () => {
    expect(ok(shrimp({ walking: undefined }, []))).toBe(false);
    expect(ok({ ...tetra, locomotion: { ...tetra.locomotion, walking } })).toBe(false);
  });

  it('requires walking for biofilm-grazer', () => {
    const grazer = { ...tetra, behaviour: { ...tetra.behaviour, traits: ['biofilm-grazer'] } };
    expect(ok(grazer)).toBe(false);
  });

  it('accepts boundary values', () => {
    expect(ok(withWalking({ strideBodyLengths: 0.05, legPairs: 4 }))).toBe(true);
    const upper = { speedMps: 1, durationS: 0.5, refractoryS: 10 };
    expect(ok(withWalking({ strideBodyLengths: 1, legPairs: 5, tailFlip: upper }))).toBe(true);
  });

  it('rejects out-of-range and malformed walking blocks', () => {
    const tf = walking.tailFlip;
    const bad: Record<string, unknown>[] = [
      { walkSpeedMps: 0 },
      { strideBodyLengths: 0.049 },
      { strideBodyLengths: 1.01 },
      { legPairs: 3 },
      { legPairs: 6 },
      { legPairs: 4.5 },
      { surfaces: [] },
      { surfaces: ['water'] },
      { tailFlip: { ...tf, durationS: 0.51 } },
      { tailFlip: { ...tf, durationS: 0 } },
      { tailFlip: { ...tf, refractoryS: 10.1 } },
      { tailFlip: { ...tf, speedMps: 0 } },
      { tailFlip: { speedMps: 0.4, durationS: 0.2 } },
      { tailFlip: { ...tf, extra: 1 } },
      { extra: 1 },
    ];
    for (const patch of bad) {
      expect(ok(withWalking(patch)), JSON.stringify(patch)).toBe(false);
    }
  });
});
