import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { speciesContentSchema } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '../../..');

const species = new Map(
  readdirSync(join(repo, 'content/species'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const s = speciesContentSchema.parse(
        JSON.parse(readFileSync(join(repo, 'content/species', f), 'utf8')),
      );
      return [s.id, s] as const;
    }),
);

interface FishModel {
  id: string;
  kind: string;
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
    if (a.kind === 'shrimp' || a.kind === 'snail' || a.kind === 'crab') {
      if (a.species === undefined)
        throw new Error(`assets/index.json: ${a.kind} "${a.id}" lacks species`);
      out.set(a.id, { id: a.id, kind: a.kind, species: a.species, tlOverSl: 1 });
      continue;
    }
    if (a.kind !== 'fish') continue;
    if (a.species === undefined || a.bounds === undefined || a.fish === undefined) {
      throw new Error(`assets/index.json: fish "${a.id}" lacks species, bounds or fish info`);
    }
    const tl = (a.bounds.max[2] ?? 0) - (a.bounds.min[2] ?? 0);
    out.set(a.id, {
      id: a.id,
      kind: a.kind,
      species: a.species,
      tlOverSl: tl / a.fish.standardLengthM,
    });
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
    'bristlenose-pleco': {
      model: 'bristlenose-pleco',
      maxSlM: 0.091,
      maxTlM: 0.091 * 1.25,
      source:
        'FishBase: 9.1 cm SL; no length-length relationship was looked up, so TL = 1.25 SL is an ' +
        'assumption for loricariids (the model draws 1.205)',
    },
    'bronze-corydoras': {
      model: 'bronze-corydoras',
      maxSlM: 0.075,
      maxTlM: 0.075 * 1.282,
      source: 'FishBase: 7.5 cm SL (Ref. 26041); TL = 1.282 SL',
    },
    discus: {
      model: 'discus',
      maxSlM: 0.137,
      maxTlM: 0.137 * 1.2,
      source:
        'FishBase: 13.7 cm SL; no length-length relationship was looked up, so TL = 1.2 SL is an ' +
        'assumption (the model draws 1.201)',
    },
    firefish: {
      model: 'firefish',
      maxSlM: 0.09 / 1.225,
      maxTlM: 0.09,
      source: 'FishBase: 9 cm TL; TL = 1.225 SL, the proportion of the lofted model',
    },
    guppy: {
      model: 'guppy-female',
      maxSlM: 0.05,
      maxTlM: 0.05 / 0.761,
      source: 'FishBase: female reaches 5 cm SL; SL = 0.761 TL',
    },
    'harlequin-rasbora': {
      model: 'harlequin-rasbora',
      maxSlM: 0.05 / 1.322,
      maxTlM: 0.05,
      source: 'FishBase: 5 cm TL; TL = 1.322 SL, the proportion of the lofted model',
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
    'cherry-shrimp': {
      model: 'cherry-shrimp',
      maxSlM: 0.035,
      maxTlM: 0.035,
      source:
        'Neocaridina davidi: females reach about 3.5 cm; the shrimp standard length is rostrum to telson',
    },
    'hermit-crab': {
      model: 'hermit-crab',
      maxSlM: 0.035,
      maxTlM: 0.035,
      source:
        'Clibanarius tricolor: shell length up to about 3.5 cm; the crab standard length is the shell length',
    },
    'nerite-snail': {
      model: 'nerite-snail',
      maxSlM: 0.025,
      maxTlM: 0.025,
      source:
        'Neritina natalensis: shell up to about 2.5 cm; the snail standard length is the shell length',
    },
    'cleaner-shrimp': {
      model: 'cleaner-shrimp',
      maxSlM: 0.055,
      maxTlM: 0.055,
      source:
        'Lysmata amboinensis: up to about 5.5 cm; the shrimp standard length is rostrum to telson',
    },
    'cleaner-wrasse': {
      model: 'cleaner-wrasse',
      maxSlM: 0.14 / 1.2,
      maxTlM: 0.14,
      source:
        'FishBase: 14 cm TL (Ref. 55367), commonly about 10 cm TL; no length-length relationship ' +
        'was looked up, so TL = 1.2 SL, the proportion of the lofted model',
    },
    'six-line-wrasse': {
      model: 'six-line-wrasse',
      maxSlM: 0.1 / 1.235,
      maxTlM: 0.1,
      source: 'FishBase: 10 cm TL; TL = 1.235 SL, the proportion of the lofted model',
    },
    'yellow-tang': {
      model: 'yellow-tang',
      maxSlM: 0.2 / 1.163,
      maxTlM: 0.2,
      source: 'FishBase: 20 cm TL (Ref. 9710); TL = 1.163 SL',
    },
  };

/**
 * Species whose models the asset pipeline builds before their content/species file lands, with the
 * same sourced maxima. An entry moves to ADULT_MAX in the PR that adds the species file; until then
 * a built model is checked against the literature TL/SL. Model ids that are not built yet are
 * planned ones.
 */
const AWAITING_CONTENT: Record<
  string,
  { model: string; maxSlM: number; maxTlM: number; source: string }
> = {
  'altolamprologus-calvus': {
    model: 'altolamprologus-calvus',
    maxSlM: 0.135 / 1.231,
    maxTlM: 0.135,
    source:
      'FishBase: 13.5 cm TL (Ref. 5598); FishBase has no length-length relationship, so TL = ' +
      '1.231 SL, the proportion of the lofted model',
  },
  'aulonocara-baenschi': {
    model: 'aulonocara-baenschi',
    maxSlM: 0.13 / 1.2725,
    maxTlM: 0.13,
    source: 'FishBase: 13 cm TL (Ref. 4975); TL = 1.2725 SL',
  },
  'labidochromis-caeruleus': {
    model: 'labidochromis-caeruleus',
    maxSlM: 0.081,
    maxTlM: 0.081 * 1.2085,
    source: 'FishBase: 8.1 cm SL (Ref. 5653); TL = 1.2085 SL',
  },
  'melanochromis-auratus': {
    model: 'melanochromis-auratus-female',
    maxSlM: 0.11 / 1.23,
    maxTlM: 0.11,
    source:
      'FishBase: 11 cm TL (Ref. 5663); FishBase has no length-length relationship, so TL = ' +
      '1.23 SL, the proportion of the lofted model',
  },
  'neolamprologus-brichardi': {
    model: 'neolamprologus-brichardi',
    maxSlM: 0.09 / 1.3199,
    maxTlM: 0.09,
    source: 'FishBase: 9 cm TL (Ref. 5667); TL = 1.3199 SL',
  },
  'neolamprologus-multifasciatus': {
    model: 'neolamprologus-multifasciatus',
    maxSlM: 0.04 / 1.25,
    maxTlM: 0.04,
    source:
      'FishBase: 4 cm TL (Ref. 5667); FishBase has no length-length relationship, so TL = 1.25 SL ' +
      'is an assumption for cichlids',
  },
  'pseudotropheus-demasoni': {
    model: 'pseudotropheus-demasoni',
    maxSlM: 0.063,
    maxTlM: 0.063 * 1.215,
    source:
      'FishBase (as Chindongo demasoni): 6.3 cm SL (Ref. 40900); FishBase has no length-length ' +
      'relationship, so TL = 1.215 SL, the proportion of the lofted model',
  },
};

/**
 * Models males wear instead of the species model, keyed by model with the species they draw
 * (apps/web/src/fish/profiles.ts sizes them by their profile's length factor).
 */
const MALE_MODELS: Readonly<Record<string, string>> = {
  'guppy-male': 'guppy',
  'melanochromis-auratus-male': 'melanochromis-auratus',
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
    const drawn = new Set(
      [...Object.values(ADULT_MAX), ...Object.values(AWAITING_CONTENT)].map((a) => a.model),
    );
    for (const m of models.values()) {
      if (drawn.has(m.id) || MALE_MODELS[m.id] !== undefined) continue;
      expect.fail(`fish model "${m.id}" needs an ADULT_MAX or AWAITING_CONTENT entry`);
    }
    for (const [id, adult] of Object.entries(ADULT_MAX)) {
      expect(models.get(adult.model)?.species, id).toBe(id);
    }
  });

  it('draws every male model as a documented species', () => {
    for (const [model, id] of Object.entries(MALE_MODELS)) {
      expect(
        ADULT_MAX[id] ?? AWAITING_CONTENT[id],
        `${model} draws undocumented "${id}"`,
      ).toBeDefined();
      const built = models.get(model);
      if (built !== undefined) expect(built.species, model).toBe(id);
    }
  });

  it('keeps a species awaiting content out of ADULT_MAX until its file lands', () => {
    for (const id of Object.keys(AWAITING_CONTENT)) {
      expect(species.has(id), `${id} has content: move it from AWAITING_CONTENT to ADULT_MAX`).toBe(
        false,
      );
      expect(ADULT_MAX[id], id).toBeUndefined();
    }
  });

  it.each(Object.entries(AWAITING_CONTENT))(
    '%s: a built model awaiting content has the literature TL/SL',
    (id, adult) => {
      expect(adult.maxSlM, adult.source).toBeLessThan(adult.maxTlM);
      const model = models.get(adult.model);
      if (model === undefined) return;
      expect(model.species, adult.model).toBe(id);
      expect(
        Math.abs((adult.maxSlM * model.tlOverSl) / adult.maxTlM - 1),
        adult.source,
      ).toBeLessThan(TOLERANCE);
    },
  );

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
