import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { speciesSchema } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '../../..');
const contentSchema = speciesSchema.partial({ render: true });

const species = new Map(
  readdirSync(join(repo, 'content/species'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const s = contentSchema.parse(
        JSON.parse(readFileSync(join(repo, 'content/species', f), 'utf8')),
      );
      return [s.id, s] as const;
    }),
);

interface FishModel {
  id: string;
  species: string;
  tlOverSl: number;
}

function fishModels(): Map<string, FishModel> {
  const index = JSON.parse(
    readFileSync(join(repo, 'apps/web/public/assets/index.json'), 'utf8'),
  ) as {
    assets: {
      id: string;
      kind: string;
      species?: string;
      bounds?: { min: number[]; max: number[] };
      fish?: { standardLengthM: number };
    }[];
  };
  const out = new Map<string, FishModel>();
  for (const a of index.assets) {
    if (a.kind !== 'fish') continue;
    if (a.species === undefined || a.bounds === undefined || a.fish === undefined) {
      throw new Error(`assets/index.json: fish "${a.id}" lacks species, bounds or fish info`);
    }
    const tl = (a.bounds.max[2] ?? 0) - (a.bounds.min[2] ?? 0);
    out.set(a.id, { id: a.id, species: a.species, tlOverSl: tl / a.fish.standardLengthM });
  }
  return out;
}

/**
 * Real adult maxima. `tlOverSl` is FishBase's length-length relationship TL = b·SL where one
 * exists. `model` is the asset the renderer draws the species with (apps/web/src/fish/profiles.ts).
 */
const ADULT_MAX: Record<
  string,
  { model: string; maxSlM: number; maxTlM: number; tlOverSl: number; source: string }
> = {
  angelfish: {
    model: 'angelfish',
    maxSlM: 0.15 / 1.304,
    maxTlM: 0.15,
    tlOverSl: 1.304,
    source: 'FishBase: 15 cm TL (Ref. 7020); TL = 1.304 SL',
  },
  'banggai-cardinalfish': {
    model: 'banggai-cardinalfish',
    maxSlM: 0.086 / 1.45,
    maxTlM: 0.086,
    tlOverSl: 1.45,
    source: 'FishBase: 8.6 cm TL (female); TL = 1.450 SL',
  },
  betta: {
    model: 'betta',
    maxSlM: 0.065 / 1.353,
    maxTlM: 0.065,
    tlOverSl: 1.353,
    source: 'FishBase: 6.5 cm TL (Ref. 12693), wild-type finnage; TL = 1.353 SL',
  },
  'blue-tang': {
    model: 'blue-tang',
    maxSlM: 0.31 / 1.162,
    maxTlM: 0.31,
    tlOverSl: 1.162,
    source: 'FishBase: 31 cm TL (Ref. 2334); TL = 1.162 SL',
  },
  'bronze-corydoras': {
    model: 'bronze-corydoras',
    maxSlM: 0.075,
    maxTlM: 0.075 * 1.282,
    tlOverSl: 1.282,
    source: 'FishBase: 7.5 cm SL (Ref. 26041); TL = 1.282 SL',
  },
  guppy: {
    model: 'guppy-female',
    maxSlM: 0.05,
    maxTlM: 0.05 / 0.761,
    tlOverSl: 1 / 0.761,
    source: 'FishBase: female reaches 5 cm SL; SL = 0.761 TL',
  },
  'neon-tetra': {
    model: 'neon-tetra',
    maxSlM: 0.025,
    maxTlM: 0.04,
    tlOverSl: 0.04 / 0.025,
    source: 'FishBase: 2.5 cm SL (Ref. 137577); about 4 cm overall length (Wikipedia, Neon tetra)',
  },
  'ocellaris-clownfish': {
    model: 'ocellaris-clownfish',
    maxSlM: 0.11 / 1.326,
    maxTlM: 0.11,
    tlOverSl: 1.326,
    source: 'FishBase: 11 cm TL; TL = 1.326 SL',
  },
  'royal-gramma': {
    model: 'royal-gramma',
    maxSlM: 0.08 / 1.277,
    maxTlM: 0.08,
    tlOverSl: 1.277,
    source: 'FishBase: 8 cm TL (Ref. 7251); TL = 1.277 SL',
  },
  'yellow-tang': {
    model: 'yellow-tang',
    maxSlM: 0.2 / 1.163,
    maxTlM: 0.2,
    tlOverSl: 1.163,
    source: 'FishBase: 20 cm TL (Ref. 9710); TL = 1.163 SL',
  },
};

/**
 * Domestic long-finned males carry a caudal fin about as long as the body, so their drawn total
 * length legitimately exceeds the wild-type maximum. Only their standard length is checked.
 */
const LONG_FIN_MORPHS = new Set(['betta']);

const TOLERANCE = 0.1;

describe('species sizes are standard lengths', () => {
  const models = fishModels();

  it('documents an adult maximum for every species and every drawn fish model', () => {
    expect([...species.keys()].sort()).toEqual(Object.keys(ADULT_MAX).sort());
    const drawn = new Set(Object.values(ADULT_MAX).map((a) => a.model));
    for (const m of models.values()) {
      if (drawn.has(m.id)) continue;
      // Not drawn by any species batch yet: the guppy roster is all female.
      expect(m.id, `fish model "${m.id}" needs an ADULT_MAX entry`).toBe('guppy-male');
    }
    for (const [id, adult] of Object.entries(ADULT_MAX)) {
      expect(models.get(adult.model)?.species, id).toBe(id);
    }
  });

  it.each(Object.entries(ADULT_MAX))('%s: maxSizeM is the literature maximum SL', (id, adult) => {
    const lifecycle = species.get(id)?.lifecycle;
    expect(lifecycle, id).toBeDefined();
    expect(Math.abs((lifecycle?.maxSizeM ?? 0) / adult.maxSlM - 1), adult.source).toBeLessThan(
      0.02,
    );
  });

  it.each(Object.entries(ADULT_MAX).filter(([id]) => !LONG_FIN_MORPHS.has(id)))(
    '%s: a fish grown to maxSizeM is drawn at the real adult TL',
    (id, adult) => {
      const model = models.get(adult.model);
      const maxSizeM = species.get(id)?.lifecycle.maxSizeM ?? 0;
      expect(model, adult.model).toBeDefined();
      const drawnTl = maxSizeM * (model?.tlOverSl ?? 0);
      expect(Math.abs(drawnTl / adult.maxTlM - 1), `${id} drawn at ${drawnTl} m`).toBeLessThan(
        TOLERANCE,
      );
    },
  );

  it('draws long-finned morphs with a caudal fin longer than the wild type', () => {
    for (const id of LONG_FIN_MORPHS) {
      const adult = ADULT_MAX[id];
      expect(adult, id).toBeDefined();
      expect(models.get(adult?.model ?? '')?.tlOverSl, id).toBeGreaterThan(adult?.tlOverSl ?? 0);
    }
  });

  it('spawns and is bought at or below the adult maximum', () => {
    for (const [id, s] of species) {
      expect(s.locomotion.bodyLengthM, id).toBeLessThanOrEqual(s.lifecycle.maxSizeM);
      expect(s.lifecycle.birthSizeM, id).toBeLessThan(s.locomotion.bodyLengthM);
    }
  });
});
