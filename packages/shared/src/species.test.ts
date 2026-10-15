import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { behaviourSchema, speciesContentSchema, traitSchema } from './species.js';

const dir = join(import.meta.dirname, '../../../content/species');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const pendingDir = join(import.meta.dirname, '../../../content/species-pending');
const pendingFiles = readdirSync(pendingDir).filter((f) => f.endsWith('.json'));

describe('content/species', () => {
  it('has species files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s passes the shared schema', (file) => {
    const raw: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    expect(speciesContentSchema.safeParse(raw).error).toBeUndefined();
  });
});

describe('content/species-pending', () => {
  it('has species files', () => {
    expect(pendingFiles.length).toBeGreaterThan(0);
  });

  it.each(pendingFiles)('%s passes the content schema', (file) => {
    const raw: unknown = JSON.parse(readFileSync(join(pendingDir, file), 'utf8'));
    expect(speciesContentSchema.safeParse(raw).error).toBeUndefined();
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
  const cherry = JSON.parse(readFileSync(join(pendingDir, 'cherry-shrimp.json'), 'utf8')) as {
    behaviour: Record<string, unknown>;
    locomotion: Record<string, unknown>;
  };
  const walking = {
    walkSpeedMps: 0.01,
    strideBodyLengths: 0.3,
    legPairs: 5,
    surfaces: ['substrate', 'decor'],
    tailFlip: { speedMps: 0.25, durationS: 0.2, refractoryS: 3 },
  };
  const shrimp = (
    loco: Record<string, unknown> = {},
    traits: string[] = ['biofilm-grazer'],
  ): unknown => ({
    ...cherry,
    behaviour: { ...cherry.behaviour, traits },
    locomotion: { ...cherry.locomotion, walking, ...loco },
  });
  const issuePaths = (v: unknown): string[] => {
    const r = speciesContentSchema.safeParse(v);
    return r.success ? [] : r.error.issues.map((issue) => issue.path.join('.'));
  };
  const ok = (v: unknown): boolean => issuePaths(v).length === 0;
  const withWalking = (patch: Record<string, unknown>): unknown =>
    shrimp({ walking: { ...walking, ...patch } });

  it('accepts a walker and the new traits', () => {
    expect(ok(shrimp())).toBe(true);
    expect(ok(shrimp({}, ['cleaner']))).toBe(true);
  });

  it('keeps shipped species valid under the checked rules', () => {
    for (const f of files) {
      const raw: unknown = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const r = speciesContentSchema.safeParse(raw);
      expect(r.error).toBeUndefined();
    }
  });

  it('requires walking exactly when swimmingMode is pleopod', () => {
    expect(issuePaths(shrimp({ walking: undefined }, []))).toEqual(['locomotion.walking']);
    const swimmer = { ...tetra, locomotion: { ...tetra.locomotion, walking } };
    expect(issuePaths(swimmer)).toContain('locomotion.walking');
  });

  it('requires walking for biofilm-grazer', () => {
    const grazer = { ...tetra, behaviour: { ...tetra.behaviour, traits: ['biofilm-grazer'] } };
    expect(issuePaths(grazer)).toEqual(['behaviour.traits']);
  });

  it('accepts boundary values', () => {
    expect(ok(withWalking({ strideBodyLengths: 0.05, legPairs: 4 }))).toBe(true);
    const upper = { speedMps: 0.25, durationS: 0.5, refractoryS: 10 };
    expect(ok(withWalking({ strideBodyLengths: 1, legPairs: 5, tailFlip: upper }))).toBe(true);
  });

  it('rejects out-of-range and malformed walking blocks at the offending field', () => {
    const tf = walking.tailFlip;
    const w = 'locomotion.walking';
    const bad: [Record<string, unknown>, string][] = [
      [{ walkSpeedMps: 0 }, `${w}.walkSpeedMps`],
      [{ strideBodyLengths: 0.049 }, `${w}.strideBodyLengths`],
      [{ strideBodyLengths: 1.01 }, `${w}.strideBodyLengths`],
      [{ legPairs: 3 }, `${w}.legPairs`],
      [{ legPairs: 6 }, `${w}.legPairs`],
      [{ legPairs: 4.5 }, `${w}.legPairs`],
      [{ surfaces: [] }, `${w}.surfaces`],
      [{ surfaces: ['water'] }, `${w}.surfaces.0`],
      [{ tailFlip: { ...tf, durationS: 0.51 } }, `${w}.tailFlip.durationS`],
      [{ tailFlip: { ...tf, durationS: 0 } }, `${w}.tailFlip.durationS`],
      [{ tailFlip: { ...tf, refractoryS: 10.1 } }, `${w}.tailFlip.refractoryS`],
      [{ tailFlip: { ...tf, speedMps: 0 } }, `${w}.tailFlip.speedMps`],
      [{ tailFlip: { speedMps: 0.25, durationS: 0.2 } }, `${w}.tailFlip.refractoryS`],
      [{ tailFlip: { ...tf, extra: 1 } }, `${w}.tailFlip`],
      [{ extra: 1 }, w],
    ];
    for (const [patch, path] of bad) {
      expect(issuePaths(withWalking(patch)), JSON.stringify(patch)).toEqual([path]);
    }
  });

  it('requires walker traits to come with walking, naming each trait', () => {
    const noWalking = (traits: string[]): unknown => ({
      ...tetra,
      behaviour: { ...tetra.behaviour, traits },
    });
    expect(issuePaths(noWalking(['cleaner']))).toEqual(['behaviour.traits']);
    expect(issuePaths(noWalking(['biofilm-grazer', 'cleaner']))).toEqual([
      'behaviour.traits',
      'behaviour.traits',
    ]);
  });

  describe('speed bounds', () => {
    const loco = cherry.locomotion as { cruiseSpeedMps: number; maxSpeedMps: number };
    const speedPath = 'locomotion.walking.walkSpeedMps';

    it('accepts walkSpeedMps equal to cruiseSpeedMps and rejects above it', () => {
      expect(ok(withWalking({ walkSpeedMps: loco.cruiseSpeedMps }))).toBe(true);
      expect(issuePaths(withWalking({ walkSpeedMps: loco.cruiseSpeedMps * 1.01 }))).toEqual([
        speedPath,
      ]);
    });

    it('accepts a tail-flip peak equal to maxSpeedMps and rejects above it', () => {
      const exact = loco.maxSpeedMps / (Math.PI / 2);
      const tf = { ...walking.tailFlip, speedMps: exact };
      expect(ok(withWalking({ tailFlip: tf }))).toBe(true);
      expect(issuePaths(withWalking({ tailFlip: { ...tf, speedMps: exact * 1.01 } }))).toEqual([
        'locomotion.walking.tailFlip.speedMps',
      ]);
    });
  });

  describe('fish-only behaviour', () => {
    const withBehaviour = (patch: Record<string, unknown>): unknown => ({
      ...(shrimp() as { behaviour: object; locomotion: object }),
      behaviour: { ...cherry.behaviour, traits: ['biofilm-grazer'], ...patch },
    });

    it('rejects schooling', () => {
      const schooling = { minGroup: 2, topologicalNeighbours: 3, tightenWhenStartled: false };
      expect(issuePaths(withBehaviour({ schooling }))).toEqual(['behaviour.schooling']);
    });

    it('rejects territorial walkers', () => {
      expect(issuePaths(withBehaviour({ territorial: true }))).toEqual(['behaviour.territorial']);
    });

    it.each(['shoal', 'air-gulp', 'glass-grazer', 'rock-grazer', 'anemone-host', 'flare-display'])(
      'rejects swimmer trait %s',
      (trait) => {
        expect(issuePaths(withBehaviour({ traits: ['biofilm-grazer', trait] }))).toEqual([
          'behaviour.traits',
        ]);
      },
    );

    it('keeps cave-dweller and cleaner allowed', () => {
      expect(ok(withBehaviour({ traits: ['cave-dweller', 'cleaner'] }))).toBe(true);
    });
  });
});
