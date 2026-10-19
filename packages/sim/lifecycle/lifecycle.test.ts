import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  chemistryParametersSchema,
  DEFAULT_EQUIPMENT,
  newTankChemistry,
  speciesSummarySchema,
  TANK_SIZES,
  type Chemistry,
  type Equipment,
  type SpeciesChemistry,
  type SpeciesLifecycle,
  type TankSize,
  type Water,
} from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import {
  applyCare,
  applyEating,
  BIOLOAD_CAPACITY_BY_SIZE,
  catchUp,
  DEFAULT_WATER_PARAMETERS,
  GRACE_PERIOD_MS,
  hasCapacityFor,
  MAX_CATCH_UP_MS,
  REFERENCE_TANK_LITRES,
  STEP_MS,
  TANK_BIOLOAD_CAPACITY,
  type LifecycleFish,
  type LifecycleState,
  type SpeciesChemistryTable,
  type SpeciesTable,
  type TankEnvironment,
} from './index.ts';

const speciesDir = join(import.meta.dirname, '../../../content/species');
const parsedSpecies = readdirSync(speciesDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) =>
    speciesSummarySchema.loose().parse(JSON.parse(readFileSync(join(speciesDir, name), 'utf8'))),
  );
const species: SpeciesTable = new Map(
  parsedSpecies.map((s) => [s.id, s.lifecycle satisfies SpeciesLifecycle] as const),
);
const speciesChemistry: SpeciesChemistryTable = new Map(
  parsedSpecies.map((s) => [s.id, s.chemistry satisfies SpeciesChemistry] as const),
);
const chemistryParams = chemistryParametersSchema.parse(
  JSON.parse(readFileSync(join(import.meta.dirname, '../../../content/chemistry.json'), 'utf8')),
);
const env: TankEnvironment = {
  biome: 'freshwater',
  litres: 300,
  bioloadCapacity: TANK_BIOLOAD_CAPACITY,
  equipment: DEFAULT_EQUIPMENT,
  species,
  speciesChemistry,
  params: DEFAULT_WATER_PARAMETERS,
  chemistryParams,
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 1);
const NO_GRACE = T0 - 1;
const NO_BREEDING = {
  breeding: new Map(),
  breedingEnvironment: {
    hasCave: false,
    maxAnimals: 60,
    bioloadCapacity: TANK_BIOLOAD_CAPACITY,
    newId: () => {
      throw new Error('no births expected');
    },
  },
};
const cleanWater: Water = { ammonia: 0, nitrate: 0, algae: 0, uneatenFood: 0 };

function fishOf(id: string, speciesId: string, over: Partial<LifecycleFish> = {}): LifecycleFish {
  const spec = species.get(speciesId);
  if (!spec) throw new Error(`no species ${speciesId}`);
  return {
    id,
    species: speciesId,
    bornAtMs: T0,
    size: spec.birthSizeM,
    hunger: 0,
    health: 1,
    alive: true,
    diedAtMs: null,
    cause: null,
    sex: 'female',
    stage: 'adult',
    lastBroodAtMs: null,
    ...over,
  };
}

function tank(
  fish: LifecycleFish[],
  water: Partial<Water> = {},
  chemistry: Partial<Chemistry> = {},
): LifecycleState {
  return {
    water: { ...cleanWater, ...water },
    chemistry: { ...newTankChemistry('freshwater'), ...chemistry },
    fish,
  };
}

function run(
  state: LifecycleState,
  ms: number,
  opts: {
    grace?: number;
    from?: number;
    feeder?: boolean;
    equipment?: Equipment;
    env?: Partial<TankEnvironment>;
  } = {},
) {
  return catchUp({
    ...env,
    ...opts.env,
    equipment: opts.equipment ?? DEFAULT_EQUIPMENT,
    state,
    fromMs: T0 + (opts.from ?? 0),
    toMs: T0 + ms,
    graceEndsAtMs: opts.grace ?? NO_GRACE,
    vacationFeeder: opts.feeder ?? false,
    ...NO_BREEDING,
  });
}

function only(result: { state: LifecycleState }): LifecycleFish {
  const [f] = result.state.fish;
  if (!f) throw new Error('no fish');
  return f;
}

describe('starvation timeline (tuning target: ~4 d harm, 7-10 d death for small fish)', () => {
  const start = tank([fishOf('a', 'neon-tetra')]);

  it('is unharmed after 3 days without food', () => {
    const f = only(run(start, 3 * DAY));
    expect(f.health).toBe(1);
    expect(f.alive).toBe(true);
    expect(f.hunger).toBeGreaterThan(0.5);
  });

  it('starts losing health at about 4 days', () => {
    expect(only(run(start, 3.9 * DAY)).health).toBe(1);
    const f = only(run(start, 5 * DAY));
    expect(f.health).toBeLessThan(0.9);
    expect(f.health).toBeGreaterThan(0.5);
  });

  it.each(['neon-tetra', 'guppy', 'betta', 'bronze-corydoras'])(
    'kills a small fish (%s) between 7 and 10 days',
    (id) => {
      const s = tank([fishOf('a', id)]);
      expect(only(run(s, 6.5 * DAY)).alive).toBe(true);
      const dead = run(s, 10 * DAY);
      expect(only(dead).alive).toBe(false);
      expect(only(dead).cause).toBe('starvation');
      const death = dead.deaths[0];
      expect(death?.diedAtMs).toBeGreaterThanOrEqual(T0 + 7 * DAY);
      expect(death?.diedAtMs).toBeLessThanOrEqual(T0 + 10 * DAY);
    },
  );

  it('keeps health a dead fish stays dead and records one death only', () => {
    const r = run(start, 30 * DAY);
    expect(r.deaths).toHaveLength(1);
    expect(only(r).health).toBe(0);
  });
});

describe('one visit a day keeps a tank healthy', () => {
  it('stays at full health for 30 days of one portion per day, eaten', () => {
    let state = tank([fishOf('a', 'neon-tetra'), fishOf('b', 'neon-tetra'), fishOf('c', 'guppy')]);
    let now = T0;
    for (let day = 0; day < 30; day++) {
      const fed = applyCare(
        state,
        { type: 'feed', food: 'flakes', portion: 3 },
        'freshwater',
        chemistryParams,
      );
      if (!fed.ok) throw new Error(fed.reason);
      const eaten = applyEating(
        fed.value,
        state.fish.map((f) => ({ fishId: f.id, portion: 1, atMs: now })),
        {
          nowMs: now,
          windowMs: HOUR,
          fedInWindow: 3,
          eatenInWindow: 0,
          eatenByFishInWindow: new Map(),
        },
      );
      if (!eaten.ok) throw new Error(eaten.reason);
      const r = catchUp({
        state: eaten.value,
        fromMs: now,
        toMs: now + DAY,
        ...env,
        graceEndsAtMs: NO_GRACE,
        vacationFeeder: false,
        ...NO_BREEDING,
      });
      state = r.state;
      now += DAY;
    }
    for (const f of state.fish) {
      expect(f.alive).toBe(true);
      expect(f.health).toBe(1);
    }
    expect(state.water.ammonia).toBeLessThan(0.1);
  });
});

describe('a tank stocked to capacity at full size under perfect daily care', () => {
  const stocks: Array<[string, Array<[string, number]>]> = [
    ['60 neon tetras', [['neon-tetra', 60]]],
    [
      'reef: 5 clownfish, 1 yellow tang, 1 blue tang',
      [
        ['ocellaris-clownfish', 5],
        ['yellow-tang', 1],
        ['blue-tang', 1],
      ],
    ],
    ['reef: 4 blue tangs', [['blue-tang', 4]]],
    ['freshwater: 10 angelfish', [['angelfish', 10]]],
  ];

  it.each(stocks)('%s has no deaths in 30 days', (_name, groups) => {
    const fish = groups.flatMap(([id, count]) =>
      Array.from({ length: count }, (_, i) =>
        fishOf(`${id}-${i}`, id, { size: species.get(id)?.maxSizeM ?? 0 }),
      ),
    );
    const capacity = fish.reduce((sum, f) => sum + (species.get(f.species)?.bioload ?? 0), 0);
    expect(capacity).toBeLessThanOrEqual(TANK_BIOLOAD_CAPACITY);
    expect(capacity).toBeGreaterThan(TANK_BIOLOAD_CAPACITY - 3.1);
    const biome = parsedSpecies.find((p) => p.id === groups[0]?.[0])?.biome ?? 'freshwater';
    let state = { ...tank(fish), chemistry: newTankChemistry(biome) };
    let now = T0;
    for (let day = 0; day < 30; day++) {
      state = {
        ...state,
        water: { ...state.water, uneatenFood: state.water.uneatenFood + 1 },
        fish: state.fish.map((f) => ({ ...f, hunger: 0 })),
      };
      const changed = applyCare(state, { type: 'water_change' }, biome, chemistryParams);
      if (!changed.ok) throw new Error(changed.reason);
      const r = catchUp({
        state: changed.value,
        fromMs: now,
        toMs: now + DAY,
        ...env,
        biome,
        graceEndsAtMs: NO_GRACE,
        vacationFeeder: false,
        ...NO_BREEDING,
      });
      expect(r.deaths).toEqual([]);
      state = r.state;
      now += DAY;
    }
    expect(state.fish.every((f) => f.alive && f.health === 1)).toBe(true);
  });

  it.each(parsedSpecies.map((s) => [s.id, s.biome] as const))(
    'a nano stocked at the old cap of 12 keeps every %s for 120 days of weekly water changes',
    (id, biome) => {
      const spec = species.get(id);
      if (!spec) throw new Error(`no species ${id}`);
      const count = Math.min(60, Math.floor(TANK_BIOLOAD_CAPACITY / spec.bioload));
      let state: LifecycleState = {
        water: cleanWater,
        chemistry: newTankChemistry(biome),
        fish: Array.from({ length: count }, (_, i) =>
          fishOf(`${id}-${i}`, id, { size: spec.maxSizeM }),
        ),
      };
      let now = T0;
      for (let day = 0; day < 120; day++) {
        state = {
          ...state,
          water: { ...state.water, uneatenFood: state.water.uneatenFood + 0.5 },
          fish: state.fish.map((f) => ({ ...f, hunger: 0 })),
        };
        if (day % 7 === 0) {
          const changed = applyCare(state, { type: 'water_change' }, biome, chemistryParams);
          if (!changed.ok) throw new Error(changed.reason);
          state = changed.value;
        }
        const r = catchUp({
          state,
          fromMs: now,
          toMs: now + DAY,
          ...env,
          litres: TANK_SIZES.nano30.litres,
          bioloadCapacity: BIOLOAD_CAPACITY_BY_SIZE.nano30,
          biome,
          graceEndsAtMs: NO_GRACE,
          vacationFeeder: false,
          ...NO_BREEDING,
        });
        expect(r.deaths).toEqual([]);
        state = r.state;
        now += DAY;
      }
    },
  );

  it('keeps bioload-only ammonia below the most sensitive tolerance with margin', () => {
    const lowest = Math.min(...[...species.values()].map((s) => s.ammoniaTolerance));
    const worst = Math.max(...[...species.values()].map((s) => s.ammoniaPerBioloadPerHour));
    const colony =
      chemistryParams.bacteria.mediaCapacityPerFilterTier * DEFAULT_EQUIPMENT.filter.tier;
    const equilibrium =
      (TANK_BIOLOAD_CAPACITY * worst) /
      (chemistryParams.bacteria.ammoniaOxidisers.conversionPerHour * colony);
    expect(equilibrium).toBeLessThan(lowest * 0.75);
  });
});

describe('overfeeding poisons the tank', () => {
  it('kills fish through ammonia when food is dropped but never eaten', () => {
    let state = tank([fishOf('a', 'neon-tetra'), fishOf('b', 'neon-tetra')]);
    let now = T0;
    const deaths: string[] = [];
    for (let day = 0; day < 14; day++) {
      for (let i = 0; i < 4; i++) {
        const fed = applyCare(
          state,
          { type: 'feed', food: 'flakes', portion: 5 },
          'freshwater',
          chemistryParams,
        );
        if (fed.ok) state = fed.value;
      }
      const r = catchUp({
        state,
        fromMs: now,
        toMs: now + DAY,
        ...env,
        graceEndsAtMs: NO_GRACE,
        vacationFeeder: false,
        ...NO_BREEDING,
      });
      state = r.state;
      now += DAY;
      deaths.push(...r.deaths.map((d) => d.cause));
    }
    expect(deaths.length).toBeGreaterThan(0);
    expect(deaths).toContain('ammonia');
  });

  it('raises ammonia above tolerance from uneaten food and decays it afterwards', () => {
    const state = tank([fishOf('a', 'neon-tetra')], { uneatenFood: 10 });
    const r = run(state, 6 * HOUR);
    expect(r.state.water.ammonia).toBeGreaterThan(0.2);
    expect(r.state.water.uneatenFood).toBeLessThan(10 * Math.exp(-2) + 0.01);
    const later = run(r.state, 5 * DAY);
    expect(later.state.water.ammonia).toBeLessThan(0.05);
  });

  it('attributes the death to ammonia, not starvation, when the filter has failed', () => {
    const state = tank([fishOf('a', 'blue-tang')], { ammonia: 3 }, { bacteria: UNCYCLED });
    const r = run(state, 5 * DAY, { equipment: { ...DEFAULT_EQUIPMENT, filter: { tier: 0 } } });
    expect(only(r).alive).toBe(false);
    expect(only(r).cause).toBe('ammonia');
  });
});

describe('recovery', () => {
  it('heals slowly after a meal', () => {
    const hurt = tank([fishOf('a', 'neon-tetra', { health: 0.4, hunger: 0 })]);
    const r = run(hurt, 2 * DAY);
    expect(only(r).health).toBeGreaterThan(0.4);
    expect(only(r).health).toBeLessThan(0.4 + 0.004 * 48 + 0.001);
  });

  it('a water change and gravel vacuum bring a poisoned tank back below tolerance', () => {
    let state = tank([fishOf('a', 'neon-tetra')], { ammonia: 0.6, nitrate: 8, uneatenFood: 6 });
    for (const type of ['water_change', 'gravel_vacuum'] as const) {
      const r = applyCare(state, { type }, 'freshwater', chemistryParams);
      if (!r.ok) throw new Error(r.reason);
      state = r.value;
    }
    expect(state.water).toMatchObject({ ammonia: 0.3, nitrate: 4, uneatenFood: 0 });
    const r = run(state, 12 * HOUR);
    expect(r.state.water.ammonia).toBeLessThan(0.2);
    expect(only(r).health).toBe(1);
  });

  it('eating reduces hunger and a recovered fish is no longer starving', () => {
    const state = tank([fishOf('a', 'neon-tetra', { hunger: 0.9, health: 0.5 })], {
      uneatenFood: 2,
    });
    const ate = applyEating(state, [{ fishId: 'a', portion: 1.5, atMs: T0 }], {
      nowMs: T0,
      windowMs: HOUR,
      fedInWindow: 2,
      eatenInWindow: 0,
      eatenByFishInWindow: new Map(),
    });
    if (!ate.ok) throw new Error(ate.reason);
    expect(ate.value.fish[0]?.hunger).toBeCloseTo(0.3);
    expect(only(run(ate.value, 12 * HOUR)).health).toBeGreaterThan(0.5);
  });
});

describe('grace period', () => {
  it('blocks health loss for the first 48 h but not afterwards', () => {
    const start = tank([fishOf('a', 'neon-tetra', { hunger: 0.95 })]);
    const graced = run(start, 2 * DAY, { grace: T0 + GRACE_PERIOD_MS });
    expect(only(graced).health).toBe(1);
    const after = run(start, 3 * DAY, { grace: T0 + GRACE_PERIOD_MS });
    expect(only(after).health).toBeLessThan(1);
  });

  it('lets a poisoned tank sit unharmed during the grace window', () => {
    const start = tank([fishOf('a', 'neon-tetra')], { ammonia: 2 });
    expect(only(run(start, 40 * HOUR, { grace: T0 + GRACE_PERIOD_MS })).health).toBe(1);
  });
});

describe('vacation feeder', () => {
  it('halves hunger growth', () => {
    const start = tank([fishOf('a', 'neon-tetra')]);
    const plain = only(run(start, 2 * DAY));
    const feeder = only(run(start, 2 * DAY, { feeder: true }));
    expect(feeder.hunger).toBeCloseTo(plain.hunger / 2, 6);
  });

  it('doubles the time before harm starts and so delays death by days', () => {
    const start = tank([fishOf('a', 'neon-tetra')]);
    expect(only(run(start, 7 * DAY)).health).toBeLessThan(1);
    expect(only(run(start, 7 * DAY, { feeder: true })).health).toBe(1);
    const plain = run(start, 30 * DAY).deaths[0]?.diedAtMs ?? 0;
    const feeder = run(start, 30 * DAY, { feeder: true }).deaths[0]?.diedAtMs ?? 0;
    expect(feeder - plain).toBeGreaterThan(3 * DAY);
  });
});

describe('catch-up resolution and cap', () => {
  it('steps in whole 10-minute increments and carries the remainder', () => {
    const r = run(tank([fishOf('a', 'neon-tetra')]), 35 * 60_000);
    expect(r.steps).toBe(3);
    expect(r.advancedToMs).toBe(T0 + 3 * STEP_MS);
    expect(r.capped).toBe(false);
    expect(r.elapsedMinutes).toBe(35);
  });

  it('does nothing for zero or negative elapsed time', () => {
    const state = tank([fishOf('a', 'neon-tetra')]);
    expect(run(state, 0).steps).toBe(0);
    const back = catchUp({
      state,
      fromMs: T0,
      toMs: T0 - HOUR,
      ...env,
      equipment: DEFAULT_EQUIPMENT,
      graceEndsAtMs: NO_GRACE,
      vacationFeeder: false,
      ...NO_BREEDING,
    });
    expect(back.steps).toBe(0);
    expect(back.state).toBe(state);
  });

  it('caps at 60 days and jumps last-tick to now', () => {
    const state = tank([fishOf('a', 'neon-tetra')]);
    const r = run(state, 400 * DAY);
    expect(r.capped).toBe(true);
    expect(r.steps).toBe(MAX_CATCH_UP_MS / STEP_MS);
    expect(r.advancedToMs).toBe(T0 + 400 * DAY);
    expect(r.state).toEqual(run(state, 400 * DAY, { from: 340 * DAY }).state);
    expect(r.deaths.every((d) => d.diedAtMs > T0 + 340 * DAY)).toBe(true);
  });

  it('is deterministic and splitting a window changes nothing', () => {
    const state = tank([fishOf('a', 'neon-tetra'), fishOf('b', 'angelfish')], { uneatenFood: 3 });
    const whole = run(state, 3 * DAY);
    expect(run(state, 3 * DAY)).toEqual(whole);
    const half = run(state, 36 * HOUR);
    const rest = catchUp({
      state: half.state,
      fromMs: half.advancedToMs,
      toMs: T0 + 3 * DAY,
      ...env,
      equipment: DEFAULT_EQUIPMENT,
      graceEndsAtMs: NO_GRACE,
      vacationFeeder: false,
      ...NO_BREEDING,
    });
    expect(rest.state).toEqual(whole.state);
  });

  it('throws loudly on an unknown species', () => {
    const state = tank([fishOf('a', 'neon-tetra', { species: 'kraken' })]);
    expect(() => run(state, DAY)).toThrow(/unknown species "kraken"/);
  });
});

describe('growth and old age', () => {
  it('grows a healthy fish towards but never past max size', () => {
    const spec = species.get('guppy');
    const r = run(tank([fishOf('a', 'guppy')]), 60 * DAY);
    expect(only(r).size).toBeGreaterThan(spec?.birthSizeM ?? 0);
    const grown = run(
      tank([fishOf('a', 'guppy', { size: (spec?.maxSizeM ?? 1) - 1e-6 })]),
      60 * DAY,
    );
    expect(only(grown).size).toBe(spec?.maxSizeM);
  });

  it('does not grow a starving fish', () => {
    const start = tank([fishOf('a', 'guppy', { hunger: 0.9 })]);
    expect(only(run(start, 2 * DAY)).size).toBe(fishOf('a', 'guppy').size);
  });

  it('dies of old age at the lifespan, keeping its health', () => {
    const spec = species.get('guppy');
    const bornAtMs = T0 - ((spec?.lifespanDays ?? 0) * DAY - 2 * HOUR);
    const r = run(tank([fishOf('a', 'guppy', { bornAtMs })]), 4 * HOUR);
    expect(only(r).alive).toBe(false);
    expect(only(r).cause).toBe('old_age');
    expect(only(r).health).toBe(1);
  });
});

describe('carcass bioload', () => {
  it('a dead fish left in the tank keeps loading the water', () => {
    const dead = fishOf('a', 'blue-tang', {
      alive: false,
      health: 0,
      diedAtMs: T0,
      cause: 'starvation',
      size: 0.3,
    });
    const r = run(tank([dead]), 2 * DAY);
    const empty = run(tank([]), 2 * DAY);
    expect(empty.state.water.ammonia).toBe(0);
    expect(r.state.water.ammonia).toBeGreaterThan(0.01);
  });
});

describe('feeding validation', () => {
  const state = tank([fishOf('a', 'neon-tetra'), fishOf('b', 'neon-tetra')], { uneatenFood: 1 });
  const ctx = {
    nowMs: T0,
    windowMs: HOUR,
    fedInWindow: 1,
    eatenInWindow: 0,
    eatenByFishInWindow: new Map<string, number>(),
  };

  it('accepts consumption within what was dropped', () => {
    const r = applyEating(
      state,
      [
        { fishId: 'a', portion: 0.5, atMs: T0 },
        { fishId: 'b', portion: 0.5, atMs: T0 - 1000 },
      ],
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.water.uneatenFood).toBeCloseTo(0);
  });

  it('rejects consumption above the food dropped in the window', () => {
    const r = applyEating(state, [{ fishId: 'a', portion: 1.5, atMs: T0 }], ctx);
    expect(r).toMatchObject({ ok: false });
  });

  it('counts food already reported eaten in the window', () => {
    const r = applyEating(state, [{ fishId: 'a', portion: 0.6, atMs: T0 }], {
      ...ctx,
      eatenInWindow: 0.5,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects more than the food left in the tank', () => {
    const r = applyEating(
      tank(state.fish as LifecycleFish[], { uneatenFood: 0.2 }),
      [{ fishId: 'a', portion: 0.5, atMs: T0 }],
      ctx,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects dead, unknown, future-dated and stale reports', () => {
    const withDead = tank([fishOf('a', 'neon-tetra', { alive: false })], { uneatenFood: 1 });
    expect(applyEating(withDead, [{ fishId: 'a', portion: 0.1, atMs: T0 }], ctx).ok).toBe(false);
    expect(applyEating(state, [{ fishId: 'zz', portion: 0.1, atMs: T0 }], ctx).ok).toBe(false);
    expect(applyEating(state, [{ fishId: 'a', portion: 0.1, atMs: T0 + HOUR }], ctx).ok).toBe(
      false,
    );
    expect(applyEating(state, [{ fishId: 'a', portion: 0.1, atMs: T0 - 2 * HOUR }], ctx).ok).toBe(
      false,
    );
  });

  it('caps what one fish can eat per window', () => {
    const big = tank(state.fish as LifecycleFish[], { uneatenFood: 5 });
    const r = applyEating(big, [{ fishId: 'a', portion: 3, atMs: T0 }], { ...ctx, fedInWindow: 5 });
    expect(r.ok).toBe(false);
  });

  it('refuses food the biome does not support and food beyond the tank limit', () => {
    expect(
      applyCare(state, { type: 'feed', food: 'nori', portion: 1 }, 'freshwater', chemistryParams)
        .ok,
    ).toBe(false);
    expect(
      applyCare(state, { type: 'feed', food: 'nori', portion: 1 }, 'reef', chemistryParams).ok,
    ).toBe(true);
    const full = tank(state.fish as LifecycleFish[], { uneatenFood: 19.5 });
    expect(
      applyCare(full, { type: 'feed', food: 'flakes', portion: 1 }, 'freshwater', chemistryParams)
        .ok,
    ).toBe(false);
  });
});

describe('capacity', () => {
  it('limits by bioload and fish count, ignoring the dead', () => {
    const group = [
      { alive: true, maxBioload: 5 },
      { alive: false, maxBioload: 100 },
    ];
    expect(hasCapacityFor(group, 7, 12, 60)).toBe(true);
    expect(hasCapacityFor(group, 7.1, 12, 60)).toBe(false);
    expect(hasCapacityFor(group, 0.1, 12, 1)).toBe(false);
  });

  it('blocks additions to an over-cap tank without touching the animals in it', () => {
    const crowded = Array.from({ length: 14 }, () => ({ alive: true, maxBioload: 0.1 }));
    expect(hasCapacityFor(crowded, 0.1, 100, 12)).toBe(false);
    expect(crowded).toHaveLength(14);
    const atCap = crowded.slice(0, 12);
    expect(hasCapacityFor(atCap, 0.1, 100, 12)).toBe(false);
    expect(hasCapacityFor(atCap.slice(0, 11), 0.1, 100, 12)).toBe(true);
  });
});

function fedDaily(state: LifecycleState, days: number, opts: Parameters<typeof run>[2] = {}) {
  let current = state;
  for (let d = 0; d < days; d++) {
    const r = run({ ...current, fish: current.fish.map((f) => ({ ...f, hunger: 0 })) }, DAY, opts);
    current = r.state;
  }
  return current;
}

const guppies = (n: number) =>
  Array.from({ length: n }, (_, i) => fishOf(`g${i}`, 'guppy', { size: 0.05 }));

const UNCYCLED = { ammoniaOxidisers: 0, nitriteOxidisers: 0 };
const stocked = () => tank([fishOf('a', 'neon-tetra'), fishOf('b', 'neon-tetra')]);

describe('nitrogen cycle', () => {
  it('a cycled tank keeps ammonia and nitrite near zero under daily bioload', () => {
    const end = fedDaily(stocked(), 20);
    expect(end.water.ammonia).toBeLessThan(0.1);
    expect(end.chemistry.nitrite).toBeLessThan(0.1);
    expect(end.fish.every((f) => f.alive && f.health === 1)).toBe(true);
  });

  it('an uncycled tank sees ammonia climb, then a nitrite spike, then both fall as colonies grow', () => {
    const eggs = tank(guppies(10), {}, { bacteria: UNCYCLED });
    const peaks = { ammonia: 0, nitrite: 0, ammoniaDay: 0, nitriteDay: 0 };
    let state = eggs;
    let now = T0;
    for (let day = 1; day <= 60; day++) {
      const r = catchUp({
        ...env,
        state: { ...state, fish: state.fish.map((f) => ({ ...f, health: 1, hunger: 0 })) },
        fromMs: now,
        toMs: now + DAY,
        graceEndsAtMs: NO_GRACE,
        vacationFeeder: false,
        ...NO_BREEDING,
      });
      state = r.state;
      now += DAY;
      if (state.water.ammonia > peaks.ammonia) {
        peaks.ammonia = state.water.ammonia;
        peaks.ammoniaDay = day;
      }
      if (state.chemistry.nitrite > peaks.nitrite) {
        peaks.nitrite = state.chemistry.nitrite;
        peaks.nitriteDay = day;
      }
    }
    expect(peaks.ammonia).toBeGreaterThan(0.3);
    expect(peaks.nitrite).toBeGreaterThan(0.3);
    expect(peaks.nitriteDay).toBeGreaterThan(peaks.ammoniaDay);
    expect(state.water.ammonia).toBeLessThan(0.1);
    expect(state.chemistry.nitrite).toBeLessThan(0.1);
    expect(state.water.nitrate).toBeGreaterThan(1);
    expect(state.chemistry.bacteria.ammoniaOxidisers).toBeGreaterThan(0.2);
    expect(state.chemistry.bacteria.nitriteOxidisers).toBeGreaterThan(0.2);
  });

  it('nitrite kills a sensitive fish and is blamed as the cause', () => {
    const state = tank(
      [fishOf('a', 'cherry-shrimp')],
      {},
      { nitrite: 3, bacteria: { ammoniaOxidisers: 1, nitriteOxidisers: 0 } },
    );
    const r = run(state, 20 * DAY);
    expect(only(r).alive).toBe(false);
    expect(only(r).cause).toBe('nitrite');
  });

  it('bottled bacteria cut the time to recover a crashed filter', () => {
    const crashed = tank(guppies(10), {}, { bacteria: UNCYCLED });
    const dosed = applyCare(crashed, { type: 'bottled_bacteria' }, 'freshwater', chemistryParams);
    if (!dosed.ok) throw new Error(dosed.reason);
    expect(dosed.value.chemistry.bacteria.ammoniaOxidisers).toBe(
      chemistryParams.bacteria.bottledBoost,
    );
    const days = (state: LifecycleState): number => {
      let s = state;
      for (let d = 1; d <= 60; d++) {
        s = fedDaily(s, 1);
        if (s.water.ammonia < 0.05 && s.chemistry.nitrite < 0.05) return d;
      }
      return 61;
    };
    expect(days(dosed.value)).toBeLessThan(days(crashed));
  });

  it('bottled bacteria never push a colony past 1', () => {
    const full = tank([fishOf('a', 'neon-tetra')]);
    const dosed = applyCare(full, { type: 'bottled_bacteria' }, 'freshwater', chemistryParams);
    if (!dosed.ok) throw new Error(dosed.reason);
    expect(dosed.value.chemistry.bacteria).toEqual({ ammoniaOxidisers: 1, nitriteOxidisers: 1 });
  });

  it('rinsing the filter in tap water kills most of the colonies and ammonia rises', () => {
    const rinsed = applyCare(stocked(), { type: 'filter_rinse' }, 'freshwater', chemistryParams);
    if (!rinsed.ok) throw new Error(rinsed.reason);
    expect(rinsed.value.chemistry.bacteria.ammoniaOxidisers).toBeCloseTo(
      chemistryParams.bacteria.rinseSurvival,
    );
    const after = run(rinsed.value, 5 * DAY).state;
    const normal = run(stocked(), 5 * DAY).state;
    expect(after.water.ammonia).toBeGreaterThan(normal.water.ammonia);
  });

  it('a filter hosts no colonies without media and shrinks them over days', () => {
    const none = run(stocked(), 30 * DAY, {
      equipment: { ...DEFAULT_EQUIPMENT, filter: { tier: 0 } },
    }).state.chemistry.bacteria;
    expect(none.ammoniaOxidisers).toBeLessThan(0.01);
    const roomy = fedDaily(stocked(), 30, {
      equipment: { ...DEFAULT_EQUIPMENT, filter: { tier: 3 } },
    }).chemistry.bacteria;
    expect(roomy.ammoniaOxidisers).toBeGreaterThan(0.95);
    const standard = fedDaily(stocked(), 30).chemistry.bacteria;
    expect(standard.ammoniaOxidisers).toBeCloseTo(
      chemistryParams.bacteria.mediaCapacityPerFilterTier,
      1,
    );
  });

  it('a water change halves nitrite and moves KH towards the source water', () => {
    const state = tank([fishOf('a', 'neon-tetra')], {}, { nitrite: 1, kh: 2 });
    const r = applyCare(state, { type: 'water_change' }, 'freshwater', chemistryParams);
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.chemistry.nitrite).toBeCloseTo(0.5);
    expect(r.value.chemistry.kh).toBeCloseTo(
      2 +
        (chemistryParams.kh.sourceWater.freshwater - 2) * chemistryParams.kh.restoredPerWaterChange,
    );
  });
});

describe('pH, KH, temperature and salinity', () => {
  it('holds a cycled, heated freshwater tank at its biome targets', () => {
    const r = run(stocked(), 10 * DAY).state.chemistry;
    expect(r.temperatureC).toBeCloseTo(25, 1);
    expect(r.salinity).toBe(0);
    expect(r.ph).toBeGreaterThan(6.8);
    expect(r.ph).toBeLessThanOrEqual(7);
  });

  it('cools an unheated tank towards room temperature and a heater holds it', () => {
    const cold = run(stocked(), 2 * DAY, {
      equipment: { ...DEFAULT_EQUIPMENT, heater: { tier: 0 } },
    }).state.chemistry.temperatureC;
    expect(cold).toBeLessThan(21.1);
    const warm = run(stocked(), 2 * DAY).state.chemistry.temperatureC;
    expect(warm).toBeCloseTo(25, 1);
  });

  it('drives a reef tank to sea salinity', () => {
    const state = {
      ...tank([fishOf('a', 'ocellaris-clownfish')]),
      chemistry: { ...newTankChemistry('reef'), salinity: 20 },
    };
    const r = run(state, 20 * DAY, { env: { biome: 'reef' } });
    expect(r.state.chemistry.salinity).toBeGreaterThan(30);
  });

  it('accumulating nitrate consumes KH and then lets pH sag', () => {
    const start = tank([fishOf('a', 'angelfish', { size: 0.15 })], {}, { kh: 3 });
    const end = run(start, 40 * DAY).state;
    expect(end.water.nitrate).toBeGreaterThan(5);
    expect(end.chemistry.kh).toBeLessThan(3);
    expect(end.chemistry.ph).toBeLessThan(7);
  });

  it('stress from a wrong-salinity tank harms slowly, far below ammonia', () => {
    const wrong = {
      ...tank([fishOf('a', 'ocellaris-clownfish')]),
      chemistry: newTankChemistry('freshwater'),
    };
    const sea = run(wrong, 5 * DAY, { env: { biome: 'freshwater' } });
    expect(only(sea).health).toBeLessThan(1);
    expect(only(sea).alive).toBe(true);
  });

  it('a fish within its ranges takes no stress damage', () => {
    expect(fedDaily(stocked(), 30).fish.every((f) => f.health === 1)).toBe(true);
  });

  it('a heater warms the tank to what the stocked fish need, and to the biome target when empty', () => {
    const discus = run(tank([fishOf('d', 'discus')]), 3 * DAY).state.chemistry.temperatureC;
    expect(discus).toBeGreaterThanOrEqual(28);
    expect(discus).toBeLessThanOrEqual(31);
    const empty = run(tank([]), 3 * DAY).state.chemistry.temperatureC;
    expect(empty).toBeCloseTo(25, 1);
  });

  it('a mixed tank settles where the stocked fish are least stressed overall', () => {
    const mixed = tank([fishOf('d', 'discus'), fishOf('d2', 'discus'), fishOf('n', 'neon-tetra')]);
    const t = run(mixed, 3 * DAY).state.chemistry.temperatureC;
    expect(t).toBeGreaterThan(27.9);
  });

  it('one heater tier reaches the blackwater target', () => {
    const state = {
      ...tank([]),
      chemistry: { ...newTankChemistry('freshwater'), temperatureC: 22 },
    };
    const t = run(state, 3 * DAY, { env: { biome: 'blackwater' } }).state.chemistry.temperatureC;
    expect(t).toBeCloseTo(27, 1);
  });

  it('a water change pulls KH towards the biome source water, not one global value', () => {
    const reef = {
      ...tank([fishOf('a', 'ocellaris-clownfish')]),
      chemistry: { ...newTankChemistry('reef'), kh: 5 },
    };
    const r = applyCare(reef, { type: 'water_change' }, 'reef', chemistryParams);
    if (!r.ok) throw new Error(r.reason);
    const { sourceWater, restoredPerWaterChange } = chemistryParams.kh;
    expect(r.value.chemistry.kh).toBeCloseTo(5 + (sourceWater.reef - 5) * restoredPerWaterChange);
    expect(r.value.chemistry.kh).toBeGreaterThan(5);
  });

  it('names water quality as the cause when out-of-range water kills a fish', () => {
    const wrong = {
      ...tank([fishOf('a', 'ocellaris-clownfish', { health: 0.001 })]),
      chemistry: newTankChemistry('freshwater'),
    };
    const result = run(wrong, 5 * DAY);
    expect(only(result).alive).toBe(false);
    expect(only(result).cause).toBe('water_quality');
  });

  it('mild stress slows recovery after a meal instead of stopping it', () => {
    const mildlyCold = {
      ...tank([fishOf('a', 'neon-tetra', { health: 0.5 })]),
      chemistry: { ...newTankChemistry('freshwater'), temperatureC: 19 },
    };
    const heaterless = { ...DEFAULT_EQUIPMENT, heater: { tier: 0 } };
    const stressed = only(run(mildlyCold, 12 * HOUR, { equipment: heaterless })).health;
    const comfortable = only(
      run(tank([fishOf('a', 'neon-tetra', { health: 0.5 })]), 12 * HOUR),
    ).health;
    expect(stressed).toBeGreaterThan(0.5);
    expect(stressed).toBeLessThan(comfortable);
  });
});

describe('offline catch-up with chemistry', () => {
  it('is deterministic and splitting a window changes nothing', () => {
    const start = tank(
      [fishOf('a', 'neon-tetra'), fishOf('b', 'guppy')],
      { uneatenFood: 4 },
      { bacteria: { ammoniaOxidisers: 0.1, nitriteOxidisers: 0.05 } },
    );
    const whole = run(start, 5 * DAY);
    const half = run(start, 2 * DAY);
    const rest = catchUp({
      ...env,
      state: half.state,
      fromMs: half.advancedToMs,
      toMs: T0 + 5 * DAY,
      graceEndsAtMs: NO_GRACE,
      vacationFeeder: false,
      ...NO_BREEDING,
    });
    expect(rest.state).toEqual(whole.state);
  });

  it('bounds a year away to 60 days of chemistry', () => {
    const start = tank([fishOf('a', 'neon-tetra')], { uneatenFood: 4 });
    const year = run(start, 365 * DAY);
    expect(year.capped).toBe(true);
    expect(year.state).toEqual(run(start, 365 * DAY, { from: 305 * DAY }).state);
  });

  it('keeps every reading finite and in range over 60 days', () => {
    const r = run(stocked(), 60 * DAY, { feeder: true }).state.chemistry;
    for (const v of [r.nitrite, r.ph, r.kh, r.temperatureC, r.salinity]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(r.ph).toBeGreaterThanOrEqual(0);
    expect(r.ph).toBeLessThanOrEqual(14);
    expect(r.kh).toBeGreaterThanOrEqual(0);
  });

  it('applyEating keeps the chemistry', () => {
    const state = tank([fishOf('a', 'neon-tetra')], { uneatenFood: 2 }, { nitrite: 0.7 });
    const ate = applyEating(state, [{ fishId: 'a', portion: 1, atMs: T0 }], {
      nowMs: T0,
      windowMs: HOUR,
      fedInWindow: 2,
      eatenInWindow: 0,
      eatenByFishInWindow: new Map(),
    });
    if (!ate.ok) throw new Error(ate.reason);
    expect(ate.value.chemistry.nitrite).toBe(0.7);
  });
});

describe('every species in every tank size under good care', () => {
  const cases = Object.entries(TANK_SIZES).flatMap(([size, { litres }]) =>
    parsedSpecies
      .filter(
        (s) =>
          Math.floor(
            BIOLOAD_CAPACITY_BY_SIZE[size as TankSize] / (species.get(s.id)?.bioload ?? NaN),
          ) >= 1,
      )
      .map((s) => [size as TankSize, litres, s.id, s.biome] as const),
  );

  it('covers every species in every size', () => {
    expect(cases.length).toBeGreaterThan(parsedSpecies.length * 3);
  });

  it.each(cases)(
    '%s (%d L): %s lives 120 days unharmed with daily food and a weekly water change',
    (size, litres, id, biome) => {
      const spec = species.get(id);
      if (!spec) throw new Error(`no species ${id}`);
      const count = Math.min(
        TANK_SIZES[size].maxAnimals,
        Math.floor(BIOLOAD_CAPACITY_BY_SIZE[size] / spec.bioload),
      );
      let state: LifecycleState = {
        water: cleanWater,
        chemistry: newTankChemistry(biome),
        fish: Array.from({ length: count }, (_, i) =>
          fishOf(`${id}-${i}`, id, { size: spec.maxSizeM }),
        ),
      };
      let now = T0;
      for (let day = 0; day < 120; day++) {
        state = {
          ...state,
          water: { ...state.water, uneatenFood: state.water.uneatenFood + 0.5 },
          fish: state.fish.map((f) => ({ ...f, hunger: 0 })),
        };
        if (day % 7 === 0) {
          const changed = applyCare(state, { type: 'water_change' }, biome, chemistryParams);
          if (!changed.ok) throw new Error(changed.reason);
          state = changed.value;
        }
        const r = catchUp({
          state,
          fromMs: now,
          toMs: now + DAY,
          ...env,
          litres,
          bioloadCapacity: BIOLOAD_CAPACITY_BY_SIZE[size],
          biome,
          graceEndsAtMs: NO_GRACE,
          vacationFeeder: false,
          ...NO_BREEDING,
        });
        expect(r.deaths).toEqual([]);
        state = r.state;
        now += DAY;
      }
      expect(state.fish.every((f) => f.alive && f.health === 1)).toBe(true);
    },
  );

  it('computes the heater setpoint a bounded number of times in a long catch-up', () => {
    const ids = [...species.keys()];
    const crowd = Array.from({ length: 60 }, (_, i) =>
      fishOf(`f${i}`, ids[i % ids.length] ?? 'guppy'),
    );
    const r = run(tank(crowd), 60 * DAY);
    const events = r.deaths.length + r.births.length;
    expect(r.steps).toBe((60 * DAY) / STEP_MS);
    expect(r.setpointComputations).toBeLessThanOrEqual(1 + events);
    expect(r.setpointComputations).toBeLessThan(r.steps / 10);
  });
});

describe('water volume', () => {
  const crowd = () =>
    tank(Array.from({ length: 12 }, (_, i) => fishOf(`n${i}`, 'neon-tetra', { hunger: 0 })));
  const nitrogen = (litres: number) => {
    const r = run(crowd(), 6 * HOUR, {
      env: { litres },
      equipment: { ...DEFAULT_EQUIPMENT, filter: { tier: 0 } },
    });
    return r.state.water.ammonia + r.state.chemistry.nitrite;
  };

  it('never damps the waste of an over-capacity standard tank', () => {
    const over = run(crowd(), 6 * HOUR, {
      env: { litres: REFERENCE_TANK_LITRES, bioloadCapacity: 0.5 },
    });
    const normal = run(crowd(), 6 * HOUR, { env: { litres: REFERENCE_TANK_LITRES } });
    expect(over.state.water.ammonia).toBeCloseTo(normal.state.water.ammonia, 10);
    expect(over.state.chemistry.nitrite).toBeCloseTo(normal.state.chemistry.nitrite, 10);
  });

  it('concentrates the same waste in less water, but less than linearly', () => {
    expect(nitrogen(30)).toBeGreaterThan(nitrogen(300) * 2);
    expect(nitrogen(30)).toBeLessThan(nitrogen(300) * 10);
    expect(nitrogen(200)).toBeGreaterThan(nitrogen(300));
    expect(nitrogen(200)).toBeLessThan(nitrogen(30));
  });

  it('has a bioload cap per size that grows with the tank', () => {
    expect(BIOLOAD_CAPACITY_BY_SIZE.nano30).toBeLessThan(BIOLOAD_CAPACITY_BY_SIZE.std200);
    expect(BIOLOAD_CAPACITY_BY_SIZE.std200).toBeLessThan(BIOLOAD_CAPACITY_BY_SIZE.long300);
    expect(BIOLOAD_CAPACITY_BY_SIZE.standard).toBe(TANK_BIOLOAD_CAPACITY);
  });
});
