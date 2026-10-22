import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  chemistryParametersSchema,
  DEFAULT_EQUIPMENT,
  newTankChemistry,
  speciesContentSummarySchema,
  type Breeding,
} from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import {
  catchUp,
  DEFAULT_WATER_PARAMETERS,
  JUVENILE_ADULT_SIZE_FRACTION,
  stageAt,
  stageBySize,
  STEP_MS,
  stepBreeding,
  TANK_BIOLOAD_CAPACITY,
  unitHash,
  type BreedingContext,
  type BreedingEnvironment,
  type LifecycleFish,
  type LifecycleState,
} from './index.ts';

const speciesDir = join(import.meta.dirname, '../../../content/species');
const catalog = new Map(
  readdirSync(speciesDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const parsed = speciesContentSummarySchema
        .loose()
        .parse(JSON.parse(readFileSync(join(speciesDir, name), 'utf8')));
      return [parsed.id, parsed] as const;
    }),
);
const lifecycles = new Map([...catalog].map(([id, s]) => [id, s.lifecycle]));
const breedings = new Map([...catalog].map(([id, s]) => [id, s.breeding]));

const speciesChemistry = new Map([...catalog].map(([id, s]) => [id, s.chemistry]));
const chemistryParams = chemistryParametersSchema.parse(
  JSON.parse(readFileSync(join(import.meta.dirname, '../../../content/chemistry.json'), 'utf8')),
);
const chemistryEnv = {
  biome: 'freshwater',
  litres: 300,
  bioloadCapacity: 12,
  equipment: DEFAULT_EQUIPMENT,
  speciesChemistry,
  chemistryParams,
} as const;

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const cleanWater = { ammonia: 0, nitrate: 0, algae: 0, tannin: 0, uneatenFood: 0 };

function env(over: Partial<BreedingEnvironment> = {}): BreedingEnvironment {
  let n = 0;
  return {
    temperatureC: 25.5,
    hasCave: false,
    maxAnimals: 60,
    bioloadCapacity: TANK_BIOLOAD_CAPACITY,
    newId: () => `fry-${++n}`,
    ...over,
  };
}

function fishOf(id: string, speciesId: string, over: Partial<LifecycleFish> = {}): LifecycleFish {
  const spec = catalog.get(speciesId);
  if (!spec) throw new Error(`no species ${speciesId}`);
  return {
    id,
    species: speciesId,
    bornAtMs: T0 - 400 * DAY,
    size: spec.lifecycle.maxSizeM,
    hunger: 0.1,
    health: 1,
    alive: true,
    diedAtMs: null,
    cause: null,
    sex: 'female',
    stage: 'adult',
    lastBroodAtMs: null,
    disease: null,
    introducedAtMs: null,
    ...over,
  };
}

const tank = (fish: LifecycleFish[], water = cleanWater): LifecycleState => ({
  water,
  chemistry: newTankChemistry('freshwater'),
  fish,
  medicine: null,
});

function ctxAt(nowMs: number, environment = env(), breeding = breedings): BreedingContext {
  return { nowMs, species: lifecycles, breeding, environment };
}

/** Steps until a brood is due; the per-step chance is hashed so this is deterministic. */
function runSteps(state: LifecycleState, steps: number, environment: BreedingEnvironment) {
  let s = state;
  const births = [];
  for (let i = 1; i <= steps; i++) {
    const r = stepBreeding(s, ctxAt(T0 + i * STEP_MS, environment));
    s = r.state;
    births.push(...r.births);
  }
  return { state: s, births };
}

const guppyPair = () => [
  fishOf('f1', 'guppy', { sex: 'female' }),
  fishOf('m1', 'guppy', { sex: 'male' }),
];
const MONTH_STEPS = (30 * DAY) / STEP_MS;

describe('unitHash', () => {
  it('is deterministic and within [0, 1)', () => {
    expect(unitHash('abc')).toBe(unitHash('abc'));
    for (let i = 0; i < 200; i++) {
      const v = unitHash(`k${i}`);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('births', () => {
  it('a healthy fed pair in range breeds within a month, with a brood inside the species range', () => {
    const { state, births } = runSteps(tank(guppyPair()), 27 * 144, env());
    expect(births.length).toBeGreaterThanOrEqual(3);
    expect(births.length).toBeLessThanOrEqual(8);
    const bornIds = new Set(births.map((b) => b.fishId));
    const fry = state.fish.filter((f) => bornIds.has(f.id));
    expect(fry).toHaveLength(births.length);
    expect(fry.every((f) => f.stage === 'fry' || f.stage === 'juvenile')).toBe(true);
    expect(fry.every((f) => f.species === 'guppy' && f.health === 1 && f.hunger === 0)).toBe(true);
    expect(births.every((b) => b.parentId === 'f1')).toBe(true);
    expect(state.fish.find((f) => f.id === 'f1')?.lastBroodAtMs).not.toBeNull();
  });

  it('is deterministic for the same state and time', () => {
    const a = runSteps(tank(guppyPair()), MONTH_STEPS, env());
    const b = runSteps(tank(guppyPair()), MONTH_STEPS, env());
    expect(a.state).toEqual(b.state);
  });

  it('respects the interval between broods', () => {
    const f = fishOf('f1', 'guppy', { lastBroodAtMs: T0 });
    const { births } = runSteps(tank([f, fishOf('m1', 'guppy', { sex: 'male' })]), 20 * 144, env());
    expect(births).toHaveLength(0);
  });

  it('needs a living adult male as well as a female', () => {
    const lone = runSteps(tank([fishOf('f1', 'guppy')]), MONTH_STEPS, env());
    expect(lone.births).toHaveLength(0);
    const widowed = runSteps(
      tank([
        fishOf('f1', 'guppy'),
        fishOf('m1', 'guppy', { sex: 'male', alive: false, diedAtMs: T0, cause: 'unknown' }),
      ]),
      MONTH_STEPS,
      env(),
    );
    expect(widowed.births).toHaveLength(0);
  });

  it('a mouthbrooder is the male', () => {
    const pair = [
      fishOf('f1', 'banggai-cardinalfish', { sex: 'female' }),
      fishOf('m1', 'banggai-cardinalfish', { sex: 'male' }),
    ];
    const { births } = runSteps(tank(pair), 2 * MONTH_STEPS, env({ temperatureC: 25.5 }));
    expect(births.length).toBeGreaterThan(0);
    expect(births.every((b) => b.parentId === 'm1')).toBe(true);
  });

  it.each([
    ['too cold', env({ temperatureC: 15 }), cleanWater, {}],
    ['too hot', env({ temperatureC: 33 }), cleanWater, {}],
    ['ammonia above tolerance', env(), { ...cleanWater, ammonia: 5 }, {}],
    ['hungry parent', env(), cleanWater, { hunger: 0.9 }],
    ['unhealthy parent', env(), cleanWater, { health: 0.4 }],
    ['too young', env(), cleanWater, { bornAtMs: T0 - 10 * DAY }],
  ])('does not breed when %s', (_label, environment, water, over) => {
    const pair = [fishOf('f1', 'guppy', over), fishOf('m1', 'guppy', { sex: 'male' })];
    const { births } = runSteps(tank(pair, water), 2 * MONTH_STEPS, environment);
    expect(births).toHaveLength(0);
  });

  it('a cave species breeds only with a shelter in the tank', () => {
    const pair = [
      fishOf('f1', 'bristlenose-pleco', { sex: 'female' }),
      fishOf('m1', 'bristlenose-pleco', { sex: 'male' }),
    ];
    const bare = runSteps(tank(pair), 90 * 144, env({ hasCave: false }));
    expect(bare.births).toHaveLength(0);
    const sheltered = runSteps(tank(pair), 90 * 144, env({ hasCave: true }));
    expect(sheltered.births.length).toBeGreaterThan(0);
  });

  it('a species without breeding never produces fry', () => {
    const pair = [
      fishOf('f1', 'neon-tetra', { sex: 'female' }),
      fishOf('m1', 'neon-tetra', { sex: 'male' }),
    ];
    expect(runSteps(tank(pair), 2 * MONTH_STEPS, env()).births).toHaveLength(0);
  });
});

describe('caps', () => {
  it('no fry are born at the animal cap', () => {
    const { births } = runSteps(tank(guppyPair()), 2 * MONTH_STEPS, env({ maxAnimals: 2 }));
    expect(births).toHaveLength(0);
  });

  it('a tank already over its cap keeps every animal and gains none', () => {
    const crowd = Array.from({ length: 5 }, (_, i) => fishOf(`n${i}`, 'neon-tetra'));
    const { state, births } = runSteps(
      tank([...guppyPair(), ...crowd]),
      2 * MONTH_STEPS,
      env({ maxAnimals: 4 }),
    );
    expect(births).toHaveLength(0);
    expect(state.fish).toHaveLength(7);
  });

  it('trims a brood to the room left under the cap', () => {
    const { births } = runSteps(tank(guppyPair()), MONTH_STEPS, env({ maxAnimals: 4 }));
    expect(births.length).toBeLessThanOrEqual(2);
  });

  it('keeps fry and juveniles to half the cap', () => {
    const { state } = runSteps(tank(guppyPair()), 6 * MONTH_STEPS, env({ maxAnimals: 12 }));
    const young = state.fish.filter((f) => f.alive && f.stage !== 'adult');
    expect(young.length).toBeLessThanOrEqual(6);
  });

  it('does not exceed the tank bioload capacity', () => {
    const { births } = runSteps(
      tank(guppyPair()),
      MONTH_STEPS,
      env({ bioloadCapacity: 0.5 + 0.25 }),
    );
    expect(births.length).toBeLessThanOrEqual(1);
  });
});

describe('juveniles of species with no fry timeline', () => {
  const neonLife = lifecycles.get('neon-tetra');
  const neonBreeding = breedings.get('neon-tetra');
  if (!neonLife || !neonBreeding) throw new Error('neon-tetra missing');

  it('has no fryGrowth, so age cannot mature it', () => {
    expect(neonBreeding.fryGrowth).toBeUndefined();
    const juvenile = fishOf('j', 'neon-tetra', { stage: 'juvenile', bornAtMs: T0 });
    expect(stageAt(juvenile, neonBreeding, T0 + 3650 * DAY)).toBe('juvenile');
  });

  it('matures once it has grown to the adult size fraction', () => {
    const at = (size: number) =>
      stageBySize(fishOf('j', 'neon-tetra', { stage: 'juvenile', size }), neonLife);
    expect(at(neonLife.maxSizeM * JUVENILE_ADULT_SIZE_FRACTION - 1e-6)).toBe('juvenile');
    expect(at(neonLife.maxSizeM * JUVENILE_ADULT_SIZE_FRACTION)).toBe('adult');
  });

  it('leaves an adult an adult and an unknown species alone', () => {
    expect(stageBySize(fishOf('a', 'neon-tetra', { stage: 'adult', size: 0.001 }), neonLife)).toBe(
      'adult',
    );
    expect(stageBySize(fishOf('j', 'neon-tetra', { stage: 'juvenile', size: 9 }), undefined)).toBe(
      'juvenile',
    );
  });

  it('promotes a grown juvenile inside the step', () => {
    const grown = fishOf('j', 'neon-tetra', {
      stage: 'juvenile',
      size: neonLife.maxSizeM,
      bornAtMs: T0,
    });
    const { state } = stepBreeding(tank([grown]), ctxAt(T0 + STEP_MS));
    expect(state.fish[0]?.stage).toBe('adult');
  });
});

describe('fry growth', () => {
  const guppy = breedings.get('guppy') as Breeding;
  const fry = fishOf('y', 'guppy', { stage: 'fry', bornAtMs: T0, size: 0.008 });

  it('moves fry to juvenile to adult by age', () => {
    const fg = guppy.fryGrowth;
    if (!fg) throw new Error('guppy needs fryGrowth');
    expect(stageAt(fry, guppy, T0 + (fg.juvenileAfterDays - 1) * DAY)).toBe('fry');
    expect(stageAt(fry, guppy, T0 + fg.juvenileAfterDays * DAY)).toBe('juvenile');
    expect(stageAt(fry, guppy, T0 + fg.adultAfterDays * DAY)).toBe('adult');
  });

  it('never regresses an adult', () => {
    expect(stageAt(fishOf('a', 'guppy', { bornAtMs: T0 }), guppy, T0 + 1)).toBe('adult');
  });

  it('fry do not breed until they are adults and old enough', () => {
    const young = [
      fishOf('f1', 'guppy', { stage: 'fry', bornAtMs: T0, sex: 'female' }),
      fishOf('m1', 'guppy', { stage: 'fry', bornAtMs: T0, sex: 'male' }),
    ];
    const { births } = runSteps(tank(young), 60 * 144, env());
    expect(births).toHaveLength(0);
  });

  const guppyLife = lifecycles.get('guppy');
  if (!guppyLife) throw new Error('guppy missing');
  const wellFed = new Map([...lifecycles, ['guppy', { ...guppyLife, hungerPerHour: 0.0005 }]]);

  it('catch-up carries newborns through later steps', () => {
    const result = catchUp({
      state: tank([
        fishOf('f1', 'guppy', { sex: 'female', hunger: 0 }),
        fishOf('m1', 'guppy', { sex: 'male', hunger: 0 }),
      ]),
      fromMs: T0,
      toMs: T0 + 10 * DAY,
      species: wellFed,
      params: DEFAULT_WATER_PARAMETERS,
      ...chemistryEnv,
      graceEndsAtMs: T0,
      vacationFeeder: false,
      breeding: breedings,
      breedingEnvironment: env(),
    });
    expect(result.births.length).toBeGreaterThan(0);
    const bornIds = new Set(result.births.map((b) => b.fishId));
    const fry = result.state.fish.filter((f) => bornIds.has(f.id));
    expect(fry).toHaveLength(result.births.length);
    expect(fry.every((f) => f.stage === 'fry' && f.alive)).toBe(true);
  });

  it('reports deaths only for fish that were in the input or were born', () => {
    const state = tank([
      fishOf('f1', 'guppy', { sex: 'female', hunger: 0 }),
      fishOf('m1', 'guppy', { sex: 'male', hunger: 0 }),
    ]);
    const result = catchUp({
      state,
      fromMs: T0,
      toMs: T0 + 40 * DAY,
      species: lifecycles,
      params: DEFAULT_WATER_PARAMETERS,
      ...chemistryEnv,
      graceEndsAtMs: T0,
      vacationFeeder: false,
      breeding: breedings,
      breedingEnvironment: env(),
    });
    const known = new Set([...state.fish.map((f) => f.id), ...result.births.map((b) => b.fishId)]);
    expect(result.deaths.length).toBeGreaterThan(0);
    expect(result.deaths.every((d) => known.has(d.fishId))).toBe(true);
  });

  describe('catch-up granularity', () => {
    const discusLife = lifecycles.get('discus');
    if (!discusLife) throw new Error('discus missing');
    const fed = new Map([...lifecycles, ['discus', { ...discusLife, hungerPerHour: 0.0002 }]]);
    const pair = () => [
      fishOf('f1', 'discus', { sex: 'female', hunger: 0, bornAtMs: T0 - 900 * DAY }),
      fishOf('m1', 'discus', { sex: 'male', hunger: 0, bornAtMs: T0 - 900 * DAY }),
    ];
    const window = (state: LifecycleState, fromMs: number, toMs: number, newId: () => string) =>
      catchUp({
        state,
        fromMs,
        toMs,
        species: fed,
        params: DEFAULT_WATER_PARAMETERS,
        ...chemistryEnv,
        graceEndsAtMs: T0,
        vacationFeeder: false,
        breeding: breedings,
        breedingEnvironment: { ...env(), newId },
      });

    it('gives the same births in one 30 day window as in 30 daily windows', () => {
      let n = 0;
      const newId = () => `fry-${++n}`;
      const whole = window(tank(pair()), T0, T0 + 30 * DAY, newId);

      n = 0;
      let state = tank(pair());
      const daily: string[] = [];
      for (let d = 0; d < 30; d++) {
        const r = window(state, T0 + d * DAY, T0 + (d + 1) * DAY, newId);
        state = r.state;
        daily.push(...r.births.map((b) => b.fishId));
      }
      expect(whole.births.length).toBeGreaterThan(0);
      expect(whole.births.map((b) => b.fishId)).toEqual(daily);
      expect(whole.state.chemistry.temperatureC).toBeCloseTo(state.chemistry.temperatureC, 9);
    });

    it('breeds on the temperature the thermostat reaches inside the window', () => {
      const cold = tank(pair());
      expect(cold.chemistry.temperatureC).toBeLessThan(28);
      const r = window(cold, T0, T0 + 30 * DAY, () => 'x');
      expect(r.births.length).toBeGreaterThan(0);
    });
  });
});
