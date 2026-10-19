import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { speciesSummarySchema, type SpeciesLifecycle, type Water } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import {
  applyCare,
  applyEating,
  catchUp,
  DEFAULT_WATER_PARAMETERS,
  GRACE_PERIOD_MS,
  hasCapacityFor,
  MAX_CATCH_UP_MS,
  STEP_MS,
  TANK_BIOLOAD_CAPACITY,
  type LifecycleFish,
  type LifecycleState,
  type SpeciesTable,
} from './index.ts';

const speciesDir = join(import.meta.dirname, '../../../content/species');
const species: SpeciesTable = new Map(
  readdirSync(speciesDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const parsed = speciesSummarySchema
        .loose()
        .parse(JSON.parse(readFileSync(join(speciesDir, name), 'utf8')));
      return [parsed.id, parsed.lifecycle satisfies SpeciesLifecycle] as const;
    }),
);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 1);
const NO_GRACE = T0 - 1;
const NO_BREEDING = {
  breeding: new Map(),
  breedingEnvironment: {
    temperatureC: 25,
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

function tank(fish: LifecycleFish[], water: Partial<Water> = {}): LifecycleState {
  return { water: { ...cleanWater, ...water }, fish };
}

function run(
  state: LifecycleState,
  ms: number,
  opts: { grace?: number; feeder?: boolean; filter?: number } = {},
) {
  return catchUp({
    state,
    fromMs: T0,
    toMs: T0 + ms,
    species,
    params: {
      ...DEFAULT_WATER_PARAMETERS,
      filterRemovalPerHour: opts.filter ?? DEFAULT_WATER_PARAMETERS.filterRemovalPerHour,
    },
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
      const fed = applyCare(state, { type: 'feed', food: 'flakes', portion: 3 }, 'freshwater');
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
        species,
        params: DEFAULT_WATER_PARAMETERS,
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
    let state = tank(fish);
    let now = T0;
    for (let day = 0; day < 30; day++) {
      state = {
        water: { ...state.water, uneatenFood: state.water.uneatenFood + 1 },
        fish: state.fish.map((f) => ({ ...f, hunger: 0 })),
      };
      const changed = applyCare(state, { type: 'water_change' }, 'freshwater');
      if (!changed.ok) throw new Error(changed.reason);
      const r = catchUp({
        state: changed.value,
        fromMs: now,
        toMs: now + DAY,
        species,
        params: DEFAULT_WATER_PARAMETERS,
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

  it('keeps bioload-only ammonia below the most sensitive tolerance with margin', () => {
    const lowest = Math.min(...[...species.values()].map((s) => s.ammoniaTolerance));
    const worst = Math.max(...[...species.values()].map((s) => s.ammoniaPerBioloadPerHour));
    const equilibrium =
      (TANK_BIOLOAD_CAPACITY * worst) / DEFAULT_WATER_PARAMETERS.filterRemovalPerHour;
    expect(equilibrium).toBeLessThan(lowest * 0.75);
  });
});

describe('overfeeding poisons the tank', () => {
  it('kills fish through ammonia when food is dropped but never eaten', () => {
    let state = tank([fishOf('a', 'neon-tetra'), fishOf('b', 'neon-tetra')]);
    let now = T0;
    const deaths: string[] = [];
    for (let day = 0; day < 14; day++) {
      for (let i = 0; i < 2; i++) {
        const fed = applyCare(state, { type: 'feed', food: 'flakes', portion: 5 }, 'freshwater');
        if (fed.ok) state = fed.value;
      }
      const r = catchUp({
        state,
        fromMs: now,
        toMs: now + DAY,
        species,
        params: DEFAULT_WATER_PARAMETERS,
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
    const state = tank([fishOf('a', 'blue-tang')], { ammonia: 3 });
    const r = run(state, 5 * DAY, { filter: 0 });
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
      const r = applyCare(state, { type }, 'freshwater');
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
      species,
      params: DEFAULT_WATER_PARAMETERS,
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
    expect(r.state).toEqual(run(state, 60 * DAY).state);
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
      species,
      params: DEFAULT_WATER_PARAMETERS,
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
    expect(applyCare(state, { type: 'feed', food: 'nori', portion: 1 }, 'freshwater').ok).toBe(
      false,
    );
    expect(applyCare(state, { type: 'feed', food: 'nori', portion: 1 }, 'reef').ok).toBe(true);
    const full = tank(state.fish as LifecycleFish[], { uneatenFood: 19.5 });
    expect(applyCare(full, { type: 'feed', food: 'flakes', portion: 1 }, 'freshwater').ok).toBe(
      false,
    );
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
