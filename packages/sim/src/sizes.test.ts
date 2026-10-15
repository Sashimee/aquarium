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
 * Real adult maxima, converted with FishBase's length-length relationship TL = b·SL where the source
 * gives only one of the two. `model` is the asset the renderer draws the species with
 * (apps/web/src/fish/profiles.ts).
 */
const ADULT_MAX: Record<string, { model: string; maxSlM: number; maxTlM: number; source: string }> =
  {
    angelfish: {
      model: 'angelfish',
      maxSlM: 0.15 / 1.304,
      maxTlM: 0.15,
      source: 'FishBase: 15 cm TL (Ref. 7020); TL = 1.304 SL',
    },
    'banggai-cardinalfish': {
      model: 'banggai-cardinalfish',
      maxSlM: 0.086 / 1.45,
      maxTlM: 0.086,
      source: 'FishBase: 8.6 cm TL (female); TL = 1.450 SL',
    },
    betta: {
      model: 'betta',
      maxSlM: 0.065 / 1.353,
      maxTlM: 0.08,
      source:
        'FishBase: 6.5 cm TL (Ref. 12693), wild-type finnage; TL = 1.353 SL. Long-finned domestic ' +
        'males included, "usually grows to about 6–8 cm" (Wikipedia, Siamese fighting fish)',
    },
    'blue-tang': {
      model: 'blue-tang',
      maxSlM: 0.31 / 1.162,
      maxTlM: 0.31,
      source: 'FishBase: 31 cm TL (Ref. 2334); TL = 1.162 SL',
    },
    'bronze-corydoras': {
      model: 'bronze-corydoras',
      maxSlM: 0.075,
      maxTlM: 0.075 * 1.282,
      source: 'FishBase: 7.5 cm SL (Ref. 26041); TL = 1.282 SL',
    },
    guppy: {
      model: 'guppy-female',
      maxSlM: 0.05,
      maxTlM: 0.05 / 0.761,
      source: 'FishBase: female reaches 5 cm SL; SL = 0.761 TL',
    },
    'neon-tetra': {
      model: 'neon-tetra',
      maxSlM: 0.025,
      maxTlM: 0.025 * 1.171,
      source:
        'FishBase: 2.5 cm SL (Ref. 137577); no length-length relationship for the neon, so that of ' +
        'its congener P. axelrodi, TL = 1.171 SL (P. simulans: 1.203)',
    },
    'ocellaris-clownfish': {
      model: 'ocellaris-clownfish',
      maxSlM: 0.11 / 1.326,
      maxTlM: 0.11,
      source: 'FishBase: 11 cm TL; TL = 1.326 SL',
    },
    'royal-gramma': {
      model: 'royal-gramma',
      maxSlM: 0.08 / 1.277,
      maxTlM: 0.08,
      source: 'FishBase: 8 cm TL (Ref. 7251); TL = 1.277 SL',
    },
    'yellow-tang': {
      model: 'yellow-tang',
      maxSlM: 0.2 / 1.163,
      maxTlM: 0.2,
      source: 'FishBase: 20 cm TL (Ref. 9710); TL = 1.163 SL',
    },
  };

/**
 * Models whose own TL/SL draws the species outside the tolerance, with the issue that fixes the
 * model and a cap a little above its error when listed. The test asserts the error is still there,
 * so a fixed model forces the entry out, and that it stays under the cap, so it cannot get worse.
 */
const KNOWN_MODEL_ERRORS: Readonly<Record<string, { issue: number; maxError: number }>> = {};

const TOLERANCE = 0.1;

describe('species sizes are standard lengths', () => {
  const models = fishModels();

  it('documents an adult maximum for every species and every drawn fish model', () => {
    expect([...species.keys()].sort()).toEqual(Object.keys(ADULT_MAX).sort());
    const drawn = new Set(Object.values(ADULT_MAX).map((a) => a.model));
    for (const m of models.values()) {
      if (drawn.has(m.id)) continue;
      // ADULT_MAX is keyed by species and the guppy's model is guppy-female; the web puts male
      // guppies in guppy-male at 0.625 of the species length (apps/web/src/fish/profiles.ts).
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

  function drawnError(id: string, adult: { model: string; maxTlM: number }): number {
    const model = models.get(adult.model);
    expect(model, adult.model).toBeDefined();
    const maxSizeM = species.get(id)?.lifecycle.maxSizeM ?? 0;
    return Math.abs((maxSizeM * (model?.tlOverSl ?? 0)) / adult.maxTlM - 1);
  }

  it.each(Object.entries(ADULT_MAX).filter(([id]) => KNOWN_MODEL_ERRORS[id] === undefined))(
    '%s: a fish grown to maxSizeM is drawn at the real adult TL',
    (id, adult) => {
      expect(drawnError(id, adult), adult.source).toBeLessThan(TOLERANCE);
    },
  );

  it('caps every known model error at or above the tolerance', () => {
    for (const [id, { issue, maxError }] of Object.entries(KNOWN_MODEL_ERRORS)) {
      expect(
        maxError,
        `${id} (#${issue}) is under TOLERANCE, so it is not a known error`,
      ).toBeGreaterThanOrEqual(TOLERANCE);
    }
  });

  it.each(
    Object.entries(KNOWN_MODEL_ERRORS).map(
      ([id, { issue, maxError }]) => [id, issue, maxError] as const,
    ),
  )(
    '%s: is still drawn off its real adult TL, within its cap, until issue #%i fixes the model',
    (id, issue, maxError) => {
      const adult = ADULT_MAX[id];
      expect(adult, id).toBeDefined();
      if (adult === undefined) return;
      const error = drawnError(id, adult);
      expect(
        error,
        `#${issue} looks fixed: remove ${id} from KNOWN_MODEL_ERRORS`,
      ).toBeGreaterThanOrEqual(TOLERANCE);
      expect(
        error,
        `${id} is drawn worse than its KNOWN_MODEL_ERRORS cap (#${issue})`,
      ).toBeLessThanOrEqual(maxError);
    },
  );

  it('spawns and is bought at or below the adult maximum', () => {
    for (const [id, s] of species) {
      expect(s.locomotion.bodyLengthM, id).toBeLessThanOrEqual(s.lifecycle.maxSizeM);
      expect(s.lifecycle.birthSizeM, id).toBeLessThan(s.locomotion.bodyLengthM);
    }
  });
});
