import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  chemistryParametersSchema,
  DEFAULT_EQUIPMENT,
  newTankChemistry,
  type FoodType,
  speciesContentSchema,
  type Water,
} from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import {
  catchUp,
  DEFAULT_WATER_PARAMETERS,
  TANK_BIOLOAD_CAPACITY,
  type LifecycleFish,
  type LifecycleState,
  type TankEnvironment,
} from '../lifecycle/index.ts';
import { HUNGER_PER_PORTION } from '../lifecycle/params.ts';
import {
  algaeAreaPerHour,
  algaeGrazer,
  cleanupSurfaces,
  crewCleanup,
  grazesWhenNoFood,
  isScavenger,
  scavengeSweepPerHour,
  type CleanupInput,
  type CrewTally,
} from './crew.ts';
import { FoodRain, SHOW_TANK, spawnMany } from './fixtures.ts';
import { FOOD_PARTICLES } from './food.ts';
import { FishState } from './snapshot.ts';
import { toSimSpecies, type SimSpecies, type SpeciesInput } from './species.ts';
import { STEP_DT, World } from './world.ts';

const LONG = 120_000;
const contentDir = join(import.meta.dirname, '../../../content/species');

function content(id: string): ReturnType<typeof speciesContentSchema.parse> {
  const raw: unknown = JSON.parse(readFileSync(join(contentDir, `${id}.json`), 'utf8'));
  return speciesContentSchema.parse(raw);
}

const PLECO = content('bristlenose-pleco');
const CORY = content('bronze-corydoras');
const DAY_PLECO: SpeciesInput = {
  ...PLECO,
  id: 'day-pleco',
  behaviour: { ...PLECO.behaviour, activity: 'diurnal' },
};
const SIM: ReadonlyMap<string, SimSpecies> = new Map(
  [PLECO, DAY_PLECO].map((s) => [s.id, toSimSpecies(s)]),
);
const SURFACES = cleanupSurfaces(SHOW_TANK);

function sim(id: string): SimSpecies {
  const sp = SIM.get(id);
  if (sp === undefined) throw new Error(`no species ${id}`);
  return sp;
}

function tankOf(species: string, count: number, light: number, seed = 4): World {
  const w = new World({
    seed,
    tank: SHOW_TANK,
    species: [PLECO, DAY_PLECO],
    fish: spawnMany(species, count),
    light,
  });
  w.settleLight();
  w.setAlgae(1);
  return w;
}

interface Watch {
  grazing: number;
  steps: number;
}

function run(w: World, steps: number, rain?: FoodRain): Watch {
  const watch = { grazing: 0, steps: 0 };
  for (let t = 0; t < steps; t++) {
    rain?.feed(w);
    w.step();
    rain?.eat(w.takeAteEvents());
    for (let i = 0; i < w.count; i++) if (w.state[i] === FishState.Graze) watch.grazing++;
    watch.steps += w.count;
  }
  return watch;
}

const total = (tally: readonly CrewTally[], key: 'algaeM2' | 'settledPortions'): number =>
  tally.reduce((s, e) => s + e[key], 0);

function cleanup(over: Partial<CleanupInput>): ReturnType<typeof crewCleanup> {
  return crewCleanup({
    crew: [{ id: 'p', species: PLECO.id, alive: true, hunger: 1 }],
    species: SIM,
    algae: 0.5,
    uneatenFood: 0,
    dtHours: 1 / 6,
    litFraction: 0,
    surfaces: SURFACES,
    ...over,
  });
}

describe('the bristlenose pleco from content', () => {
  it('loads as a nocturnal bottom forager that scavenges and grazes glass', () => {
    const sp = sim(PLECO.id);
    expect(sp.gait).toBe('forage');
    expect(sp.activity).toBe('nocturnal');
    expect(algaeGrazer(sp)).toBe('glass');
    expect(isScavenger(sp)).toBe(true);
    expect(grazesWhenNoFood(sp)).toBe(true);
    expect(sp.home).toBe('cave');
  });
});

describe('a pleco in a running world', { timeout: LONG }, () => {
  it('grazes glass at night when no food has settled, at the offline rate', () => {
    const w = tankOf(PLECO.id, 6, 0);
    run(w, 30 * 60);
    w.takeCrewTally();
    const steps = 30 * 300;
    const watch = run(w, steps);
    expect(watch.grazing).toBeGreaterThan(0.3 * watch.steps);
    const tally = w.takeCrewTally();
    expect(total(tally, 'settledPortions')).toBe(0);
    const perHour = total(tally, 'algaeM2') / 6 / ((steps * STEP_DT) / 3600);
    const offline = algaeAreaPerHour(sim(PLECO.id));
    expect(perHour).toBeGreaterThan(0.5 * offline);
    expect(perHour).toBeLessThan(2 * offline);
  });

  it('leaves the glass for food that has settled, and goes back to it once that is eaten', () => {
    const w = tankOf(PLECO.id, 2, 0);
    run(w, 30 * 60);
    const rain = new FoodRain(SHOW_TANK);
    rain.place('algae-wafer', 0.3, w.basin.ground(0.3, 0) + 0.004, 0);
    let grazingWithFood = 0;
    let t = 0;
    for (; t < 30 * 600 && rain.count > 0; t++) {
      grazingWithFood += run(w, 1, rain).grazing;
    }
    expect(rain.count).toBe(0);
    expect(grazingWithFood).toBe(0);
    expect(t).toBeGreaterThan(1);
    expect(total(w.takeCrewTally(), 'settledPortions')).toBeCloseTo(0.5, 9);
    expect(run(w, 30 * 120).grazing).toBeGreaterThan(0);
  });

  it('keeps grazing beside settled food once it is sated', () => {
    const w = tankOf(PLECO.id, 1, 0);
    run(w, 30 * 60);
    w.behaviour.feeding.gut[0] = 1;
    const rain = new FoodRain(SHOW_TANK);
    rain.place('pellets', 0.3, w.basin.ground(0.3, 0) + 0.004, 0);
    const watch = run(w, 30 * 120, rain);
    expect(rain.eaten).toBe(0);
    expect(watch.grazing).toBeGreaterThan(0);
  });

  it('keeps grazing beside settled food that is off its diet', () => {
    const w = tankOf(PLECO.id, 1, 0);
    run(w, 30 * 60);
    const rain = new FoodRain(SHOW_TANK);
    rain.place('bloodworms', 0.3, w.basin.ground(0.3, 0) + 0.004, 0);
    rain.place('brine-shrimp', -0.3, w.basin.ground(-0.3, 0) + 0.004, 0);
    const watch = run(w, 30 * 120, rain);
    expect(rain.eaten).toBe(0);
    expect(watch.grazing).toBeGreaterThan(0.3 * watch.steps);
  });

  it('keeps grazing beside food lodged inside rock', () => {
    const w = new World({
      seed: 4,
      tank: SHOW_TANK,
      species: [PLECO],
      decor: [
        {
          id: 'rock',
          hard: true,
          kind: 'box',
          center: [0.3, 0.05, 0],
          halfExtents: [0.05, 0.05, 0.05],
          rotationY: 0,
          rounding: 0,
        },
      ],
      fish: spawnMany(PLECO.id, 1),
      light: 0,
    });
    w.settleLight();
    w.setAlgae(1);
    run(w, 30 * 60);
    const rain = new FoodRain(SHOW_TANK);
    rain.place('pellets', 0.3, 0.05, 0);
    const watch = run(w, 30 * 120, rain);
    expect(rain.eaten).toBe(0);
    expect(watch.grazing).toBeGreaterThan(0.3 * watch.steps);
  });

  it('settles back onto a surface before grazing again once the food is eaten', () => {
    const w = tankOf(PLECO.id, 1, 0);
    run(w, 30 * 60);
    for (let t = 0; t < 30 * 60 && w.state[0] !== FishState.Graze; t++) run(w, 1);
    expect(w.state[0]).toBe(FishState.Graze);
    const px = w.position[0] ?? 0;
    const x = px > 0 ? -0.5 : 0.5;
    const rain = new FoodRain(SHOW_TANK);
    rain.place('pellets', x, w.basin.ground(x, 0) + 0.004, 0);
    const states: number[] = [];
    for (let t = 0; t < 30 * 600 && rain.count > 0; t++) {
      run(w, 1, rain);
      states.push(w.state[0] ?? -1);
    }
    expect(rain.count).toBe(0);
    expect(states).toContain(FishState.Forage);
    for (let t = 0; t < 30 * 60; t++) {
      run(w, 1, rain);
      states.push(w.state[0] ?? -1);
    }
    const lastFed = Math.max(
      states.lastIndexOf(FishState.Feed),
      states.lastIndexOf(FishState.Forage),
    );
    const next = states.indexOf(FishState.Graze, lastFed);
    expect(next).toBeGreaterThan(lastFed + 1);
  });

  it('grazes only in its active hours: a nocturnal one in the dark, a diurnal one by day', () => {
    for (const [species, active, idle] of [
      [PLECO.id, 0, 1],
      [DAY_PLECO.id, 1, 0],
    ] as const) {
      const awake = tankOf(species, 3, active);
      run(awake, 30 * 60);
      awake.takeCrewTally();
      expect(run(awake, 30 * 120).grazing, species).toBeGreaterThan(0);
      expect(total(awake.takeCrewTally(), 'algaeM2'), species).toBeGreaterThan(0);

      const resting = tankOf(species, 3, idle);
      run(resting, 30 * 60);
      resting.takeCrewTally();
      expect(run(resting, 30 * 120).grazing, species).toBe(0);
      expect(resting.takeCrewTally(), species).toEqual([]);
    }
  });

  it('gives the same tally and trajectory for the same seed and a different one for another', () => {
    const go = (seed: number) => {
      const w = tankOf(PLECO.id, 3, 0, seed);
      const rain = new FoodRain(SHOW_TANK);
      rain.place('pellets', -0.2, w.basin.ground(-0.2, 0) + 0.004, 0.05);
      const tallies: (readonly CrewTally[])[] = [];
      for (let k = 0; k < 4; k++) {
        run(w, 30 * 30, rain);
        tallies.push(w.takeCrewTally());
      }
      return { tallies, position: Array.from(w.position), eaten: rain.eaten };
    };
    const a = go(31);
    expect(a.tallies.flat().some((e) => e.algaeM2 > 0)).toBe(true);
    expect(go(31)).toEqual(a);
    expect(go(32).position).not.toEqual(a.position);
  });
});

describe('a pleco in the offline crew model', () => {
  it('grazes in the dark when no food has settled, and nothing while the lamp is on', () => {
    const dark = cleanup({});
    expect(dark.algaeGrazed).toBeGreaterThan(0);
    expect(dark.foodEaten).toBe(0);
    expect(cleanup({ litFraction: 1, uneatenFood: 2 })).toEqual({
      algaeGrazed: 0,
      foodEaten: 0,
      perFish: [],
    });
  });

  it('a diurnal one grazes by day and not in the dark', () => {
    const crew = [{ id: 'd', species: DAY_PLECO.id, alive: true, hunger: 1 }];
    expect(cleanup({ crew, litFraction: 1 }).algaeGrazed).toBeGreaterThan(0);
    expect(cleanup({ crew, litFraction: 0 }).algaeGrazed).toBe(0);
  });

  it('scavenges first and grazes for what is left of the step once the food is down', () => {
    const fast = cleanup({ uneatenFood: 0.5, dtHours: 1 / 3600 });
    expect(fast.foodEaten).toBeGreaterThan(0);
    expect(fast.algaeGrazed).toBe(0);
    const step = cleanup({ uneatenFood: 0.5 });
    expect(step.foodEaten).toBeGreaterThan(0.45);
    expect(step.algaeGrazed).toBeGreaterThan(0);
    expect(step.algaeGrazed).toBeLessThan(cleanup({}).algaeGrazed);
  });

  it('grazes the whole step beside food that is off its diet', () => {
    const offDiet = cleanup({ uneatenFood: 2, uneatenFoodTypes: ['bloodworms', 'brine-shrimp'] });
    expect(offDiet.foodEaten).toBe(0);
    expect(offDiet.algaeGrazed).toBeCloseTo(cleanup({}).algaeGrazed, 12);
    const mixed = cleanup({ uneatenFood: 2, uneatenFoodTypes: ['bloodworms', 'pellets'] });
    expect(mixed.foodEaten).toBeGreaterThan(0);
    expect(cleanup({ uneatenFood: 2 }).foodEaten).toBe(mixed.foodEaten);
    expect(cleanup({ uneatenFood: 2, uneatenFoodTypes: [] })).toEqual(cleanup({}));
  });

  it('rejects an unknown uneaten food type', () => {
    const uneatenFoodTypes = JSON.parse('["kibble"]') as FoodType[];
    expect(() => cleanup({ uneatenFood: 2, uneatenFoodTypes })).toThrow(
      /unknown food type "kibble"/,
    );
  });

  it('grazes the whole step when less than the smallest particle of food is left', () => {
    for (const uneatenFood of [0, 0.01, 0.02]) {
      const scraps = cleanup({ uneatenFood });
      expect(scraps.foodEaten, `${uneatenFood}`).toBe(0);
      expect(scraps.algaeGrazed, `${uneatenFood}`).toBeCloseTo(cleanup({}).algaeGrazed, 12);
    }
  });

  it('leaves the food still found after it turned to the glass to the other scavengers', () => {
    const species = new Map([...SIM, [CORY.id, toSimSpecies(CORY)]]);
    const crew = [
      { id: 'p', species: PLECO.id, alive: true, hunger: 1 },
      { id: 'c', species: CORY.id, alive: true, hunger: 1 },
    ];
    const r = cleanup({ crew, species, uneatenFood: 0.5, dtHours: 2, litFraction: 0.5 });
    const pleco = scavengeSweepPerHour(sim(PLECO.id));
    const cory = scavengeSweepPerHour(toSimSpecies(CORY));
    const found = 0.5 - Math.min(...Object.values(FOOD_PARTICLES).map((p) => p.portion));
    const share = (id: string) => r.perFish.find((e) => e.id === id)?.food ?? 0;
    expect(share('p')).toBeCloseTo((found * pleco) / (pleco + cory), 12);
    expect(share('c')).toBeGreaterThan((found * cory) / (pleco + cory));
    expect(r.algaeGrazed).toBeGreaterThan(0);
  });

  it('grazes the whole step beside food once it is sated', () => {
    const sated = cleanup({
      crew: [{ id: 'p', species: PLECO.id, alive: true, hunger: 0 }],
      uneatenFood: 2,
    });
    expect(sated.foodEaten).toBe(0);
    expect(sated.algaeGrazed).toBeCloseTo(cleanup({}).algaeGrazed, 12);
  });

  it('gives one long step the same algae and food as two halves', () => {
    const whole = cleanup({ uneatenFood: 0.4, dtHours: 0.2 });
    const first = cleanup({ uneatenFood: 0.4, dtHours: 0.1 });
    const second = cleanup({
      algae: 0.5 - first.algaeGrazed,
      uneatenFood: 0.4 - first.foodEaten,
      dtHours: 0.1,
      crew: [
        {
          id: 'p',
          species: PLECO.id,
          alive: true,
          hunger: 1 - first.foodEaten * HUNGER_PER_PORTION,
        },
      ],
    });
    expect(first.algaeGrazed + second.algaeGrazed).toBeCloseTo(whole.algaeGrazed, 12);
    expect(first.foodEaten + second.foodEaten).toBeCloseTo(whole.foodEaten, 12);
  });
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 1);
const LIT_FROM = T0 + 8 * HOUR;
const DARK_FROM = T0 + 20 * HOUR;

describe('a pleco in the offline catch-up', () => {
  const env: TankEnvironment = {
    biome: 'freshwater',
    litres: 300,
    bioloadCapacity: TANK_BIOLOAD_CAPACITY,
    equipment: DEFAULT_EQUIPMENT,
    species: new Map([[PLECO.id, PLECO.lifecycle]]),
    speciesChemistry: new Map([[PLECO.id, PLECO.chemistry]]),
    params: DEFAULT_WATER_PARAMETERS,
    chemistryParams: chemistryParametersSchema.parse(
      JSON.parse(readFileSync(join(contentDir, '../chemistry.json'), 'utf8')),
    ),
  };
  const crew = {
    species: new Map([[PLECO.id, sim(PLECO.id)]]),
    surfaces: cleanupSurfaces({ width: 1.18, depth: 0.48, height: 0.46 }),
  };

  function pleco(id: string): LifecycleFish {
    return {
      id,
      species: PLECO.id,
      bornAtMs: T0,
      size: 0.08,
      hunger: 0.5,
      health: 1,
      alive: true,
      diedAtMs: null,
      cause: null,
      sex: 'female',
      stage: 'adult',
      lastBroodAtMs: null,
      disease: null,
      introducedAtMs: null,
    };
  }

  function tank(water: Partial<Water>): LifecycleState {
    return {
      water: { ammonia: 0, nitrate: 0, algae: 0, uneatenFood: 0, ...water },
      chemistry: newTankChemistry('freshwater'),
      fish: [pleco('p0'), pleco('p1')],
      medicine: null,
    };
  }

  function run(state: LifecycleState, fromMs: number, toMs: number, withCrew: boolean) {
    return catchUp({
      ...env,
      state,
      fromMs,
      toMs,
      graceEndsAtMs: T0 + 100 * DAY,
      vacationFeeder: false,
      breeding: new Map(),
      breedingEnvironment: {
        hasCave: false,
        maxAnimals: 60,
        bioloadCapacity: TANK_BIOLOAD_CAPACITY,
        newId: () => {
          throw new Error('no births expected');
        },
      },
      ...(withCrew ? { crew } : {}),
    });
  }

  it('grazes algae down over a dark catch-up and leaves it over a lit one', () => {
    const start = tank({ algae: 0.5 });
    const dark = run(start, DARK_FROM, DARK_FROM + 10 * HOUR, true);
    const darkBare = run(start, DARK_FROM, DARK_FROM + 10 * HOUR, false);
    expect(dark.state.water.algae).toBeLessThan(darkBare.state.water.algae);
    const lit = run(start, LIT_FROM, LIT_FROM + 10 * HOUR, true);
    const litBare = run(start, LIT_FROM, LIT_FROM + 10 * HOUR, false);
    expect(lit.state.water).toEqual(litBare.state.water);
  });

  it('counts each span once: two halves equal one whole', () => {
    const start = tank({ algae: 0.5, uneatenFood: 1.5 });
    const whole = run(start, LIT_FROM, LIT_FROM + 24 * HOUR, true);
    const half = run(start, LIT_FROM, LIT_FROM + 15 * HOUR, true);
    const rest = run(half.state, half.advancedToMs, LIT_FROM + 24 * HOUR, true);
    expect(rest.state.water).toEqual(whole.state.water);
    expect(rest.state.fish).toEqual(whole.state.fish);
    expect(whole.state.water.algae).toBeLessThan(
      run(start, LIT_FROM, LIT_FROM + 24 * HOUR, false).state.water.algae,
    );
  });

  it('is deterministic', () => {
    const start = tank({ algae: 0.5, uneatenFood: 1.5 });
    expect(run(start, DARK_FROM, DARK_FROM + DAY, true)).toEqual(
      run(start, DARK_FROM, DARK_FROM + DAY, true),
    );
  });
});
