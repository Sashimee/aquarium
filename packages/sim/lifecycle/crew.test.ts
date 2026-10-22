import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  chemistryParametersSchema,
  DEFAULT_EQUIPMENT,
  newTankChemistry,
  speciesContentSchema,
  type FoodType,
  type Water,
} from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { cleanupSurfaces, SETTLED_FOOD_MIN_PORTIONS } from '../src/crew.ts';
import { toSimSpecies, type SimSpecies } from '../src/species.ts';
import {
  applyCare,
  catchUp,
  DEFAULT_WATER_PARAMETERS,
  STEP_MS,
  TANK_BIOLOAD_CAPACITY,
  type CatchUpCrew,
  type LifecycleFish,
  type LifecycleState,
  type TankEnvironment,
} from './index.ts';

const speciesDir = join(import.meta.dirname, '../../../content/species');
const contents = ['nerite-snail', 'hermit-crab', 'bristlenose-pleco'].map((id) =>
  speciesContentSchema.parse(JSON.parse(readFileSync(join(speciesDir, `${id}.json`), 'utf8'))),
);
const crewSpecies: ReadonlyMap<string, SimSpecies> = new Map(
  contents.map((s) => [s.id, toSimSpecies(s)]),
);
const crew: CatchUpCrew = {
  species: crewSpecies,
  surfaces: cleanupSurfaces({ width: 1.18, depth: 0.48, height: 0.46 }),
};
const env: TankEnvironment = {
  biome: 'freshwater',
  litres: 300,
  bioloadCapacity: TANK_BIOLOAD_CAPACITY,
  equipment: DEFAULT_EQUIPMENT,
  species: new Map(contents.map((s) => [s.id, s.lifecycle])),
  speciesChemistry: new Map(contents.map((s) => [s.id, s.chemistry])),
  params: DEFAULT_WATER_PARAMETERS,
  chemistryParams: chemistryParametersSchema.parse(
    JSON.parse(readFileSync(join(import.meta.dirname, '../../../content/chemistry.json'), 'utf8')),
  ),
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 1);
const LIT_FROM = T0 + 8 * HOUR;
const DARK_FROM = T0 + 20 * HOUR;
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

function member(id: string, species: string, over: Partial<LifecycleFish> = {}): LifecycleFish {
  const spec = env.species.get(species);
  if (!spec) throw new Error(`no species ${species}`);
  return {
    id,
    species,
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
    disease: null,
    introducedAtMs: null,
    ...over,
  };
}

function tank(fish: LifecycleFish[], water: Partial<Water>): LifecycleState {
  return {
    water: { ammonia: 0, nitrate: 0, algae: 0, uneatenFood: 0, ...water },
    chemistry: newTankChemistry('freshwater'),
    fish,
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
    vacationFeeder: true,
    ...NO_BREEDING,
    ...(withCrew ? { crew } : {}),
  });
}

const snails = (n: number, over: Partial<LifecycleFish> = {}) =>
  Array.from({ length: n }, (_, i) => member(`s${i}`, 'nerite-snail', over));
const crabs = (n: number, over: Partial<LifecycleFish> = {}) =>
  Array.from({ length: n }, (_, i) => member(`c${i}`, 'hermit-crab', over));

describe('clean-up crew in the offline catch-up', () => {
  it('lowers algae over a lit catch-up', () => {
    const start = tank(snails(10), { algae: 0.6 });
    const bare = run(start, LIT_FROM, LIT_FROM + 12 * HOUR, false);
    const grazed = run(start, LIT_FROM, LIT_FROM + 12 * HOUR, true);
    expect(grazed.state.water.algae).toBeLessThan(bare.state.water.algae * 0.95);
    expect(grazed.state.water.algae).toBeGreaterThanOrEqual(0);
  });

  it('does nothing over a dark catch-up', () => {
    const start = tank([...snails(10), ...crabs(5)], { algae: 0.6, uneatenFood: 2 });
    const bare = run(start, DARK_FROM, DARK_FROM + 12 * HOUR, false);
    const rested = run(start, DARK_FROM, DARK_FROM + 12 * HOUR, true);
    expect(rested.state.water.algae).toBe(bare.state.water.algae);
    expect(rested.state.water.uneatenFood).toBe(bare.state.water.uneatenFood);
  });

  it('lowers uneaten food when crabs scavenge by lamp light', () => {
    const start = tank(crabs(6, { hunger: 0.9 }), { uneatenFood: 4 });
    const bare = run(start, LIT_FROM, LIT_FROM + 2 * HOUR, false);
    const fed = run(start, LIT_FROM, LIT_FROM + 2 * HOUR, true);
    expect(fed.state.water.uneatenFood).toBeLessThan(bare.state.water.uneatenFood * 0.9);
  });

  it('credits the food eaten against hunger', () => {
    const start = tank(crabs(6, { hunger: 0.9 }), { uneatenFood: 4 });
    const bare = run(start, LIT_FROM, LIT_FROM + 2 * HOUR, false);
    const fed = run(start, LIT_FROM, LIT_FROM + 2 * HOUR, true);
    const hunger = (r: typeof bare) => r.state.fish.reduce((sum, f) => sum + f.hunger, 0);
    expect(hunger(fed)).toBeLessThan(hunger(bare));
    for (const f of fed.state.fish) expect(f.hunger).toBeGreaterThanOrEqual(0);
  });

  it('cleans a fry-sized crew less than the same crew grown', () => {
    const grown = tank(snails(10, { size: 0.02 }), { algae: 0.6 });
    const fry = tank(snails(10, { size: 0.004, stage: 'fry' }), { algae: 0.6 });
    const span = [LIT_FROM, LIT_FROM + 12 * HOUR] as const;
    const grazedBy = (start: LifecycleState) => 0.6 - run(start, ...span, true).state.water.algae;
    expect(grazedBy(fry)).toBeLessThan(grazedBy(grown) * 0.5);
  });

  it('leaves a dead crew member out', () => {
    const dead = member('d', 'nerite-snail', { alive: false, diedAtMs: T0, cause: 'starvation' });
    const start = tank([dead], { algae: 0.6 });
    const bare = run(start, LIT_FROM, LIT_FROM + 6 * HOUR, false);
    const withDead = run(start, LIT_FROM, LIT_FROM + 6 * HOUR, true);
    expect(withDead.state.water.algae).toBe(bare.state.water.algae);
  });

  it('stays deterministic and quick over the 60-day cap', () => {
    const start = tank([...snails(8), ...crabs(8)], { algae: 0.5, uneatenFood: 1 });
    const t0 = performance.now();
    const a = run(start, T0, T0 + 90 * DAY, true);
    const elapsed = performance.now() - t0;
    const b = run(start, T0, T0 + 90 * DAY, true);
    expect(a.capped).toBe(true);
    expect(a.steps).toBe((60 * DAY) / STEP_MS);
    expect(b).toEqual(a);
    expect(elapsed).toBeLessThan(5000);
    const bare = run(start, T0, T0 + 90 * DAY, false);
    expect(a.state.water.algae).toBeLessThan(bare.state.water.algae);
  });

  it('counts each span once: two halves equal one whole', () => {
    const start = tank([...snails(8), ...crabs(4)], { algae: 0.5, uneatenFood: 2 });
    const whole = run(start, LIT_FROM, LIT_FROM + 24 * HOUR, true);
    const half = run(start, LIT_FROM, LIT_FROM + 12 * HOUR, true);
    const rest = run(half.state, half.advancedToMs, LIT_FROM + 24 * HOUR, true);
    expect(rest.state.water).toEqual(whole.state.water);
    expect(rest.state.fish).toEqual(whole.state.fish);
  });

  describe('food types', () => {
    const plecos = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        member(`p${i}`, 'bristlenose-pleco', { hunger: 0.9, size: 0.1 }),
      );

    it('leaves food off the diet to a hungry pleco, which grazes the span instead', () => {
      const withFood = (types?: FoodType[]) =>
        tank(plecos(2), {
          algae: 0.6,
          uneatenFood: 3,
          ...(types ? { uneatenFoodTypes: types } : {}),
        });
      const anyFood = run(withFood(), DARK_FROM, DARK_FROM + 2 * HOUR, true);
      const offDiet = run(withFood(['bloodworms']), DARK_FROM, DARK_FROM + 2 * HOUR, true);
      const onDiet = run(withFood(['pellets']), DARK_FROM, DARK_FROM + 2 * HOUR, true);
      expect(offDiet.state.water.uneatenFood).toBeGreaterThan(anyFood.state.water.uneatenFood);
      expect(offDiet.state.water.algae).toBeLessThan(anyFood.state.water.algae);
      expect(onDiet.state.water.uneatenFood).toBe(anyFood.state.water.uneatenFood);
    });

    it('records each fed type once and forgets them on a gravel vacuum', () => {
      const params = env.chemistryParams;
      let state = tank(plecos(1), {});
      for (const food of ['bloodworms', 'flakes', 'bloodworms'] as const) {
        const fed = applyCare(state, { type: 'feed', food, portion: 1 }, 'freshwater', params, T0);
        if (!fed.ok) throw new Error(fed.reason);
        state = fed.value;
      }
      expect(state.water.uneatenFood).toBe(3);
      expect(state.water.uneatenFoodTypes).toEqual(['bloodworms', 'flakes']);

      const vacuumed = applyCare(state, { type: 'gravel_vacuum' }, 'freshwater', params, T0);
      if (!vacuumed.ok) throw new Error(vacuumed.reason);
      expect(vacuumed.value.water.uneatenFood).toBe(0);
      expect(vacuumed.value.water.uneatenFoodTypes).toEqual([]);
    });

    it('starts a fresh record once earlier food has decayed below a particle', () => {
      const params = env.chemistryParams;
      const feed = (state: LifecycleState, food: FoodType, nowMs: number) => {
        const fed = applyCare(
          state,
          { type: 'feed', food, portion: 1 },
          'freshwater',
          params,
          nowMs,
        );
        if (!fed.ok) throw new Error(fed.reason);
        return fed.value;
      };
      const flaked = feed(tank(plecos(1), {}), 'flakes', T0);
      const later = run(flaked, T0, T0 + DAY, false);
      expect(later.state.water.uneatenFood).toBeGreaterThan(0);
      const bloodworms = feed(later.state, 'bloodworms', T0 + DAY);
      expect(bloodworms.water.uneatenFoodTypes).toEqual(['bloodworms']);

      const legacy = feed(tank(plecos(1), { uneatenFood: 1e-4 }), 'bloodworms', T0);
      expect(legacy.water.uneatenFoodTypes).toEqual(['bloodworms']);

      const stillThere = feed(feed(tank(plecos(1), {}), 'flakes', T0), 'bloodworms', T0);
      expect(stillThere.water.uneatenFoodTypes).toEqual(['flakes', 'bloodworms']);
    });

    it('restarts the record at the level where crewCleanup stops looking for settled food', () => {
      const feedBloodworms = (uneatenFood: number) => {
        const fed = applyCare(
          tank(plecos(1), { uneatenFood, uneatenFoodTypes: ['flakes'] }),
          { type: 'feed', food: 'bloodworms', portion: 1 },
          'freshwater',
          env.chemistryParams,
          T0,
        );
        if (!fed.ok) throw new Error(fed.reason);
        return fed.value.water.uneatenFoodTypes;
      };
      const algaeAfterCleanup = (uneatenFood: number) =>
        run(
          tank(plecos(2), { algae: 0.6, uneatenFood, uneatenFoodTypes: ['pellets'] }),
          DARK_FROM,
          DARK_FROM + 2 * HOUR,
          true,
        ).state.water.algae;
      const above = SETTLED_FOOD_MIN_PORTIONS * 1.5;
      expect(feedBloodworms(SETTLED_FOOD_MIN_PORTIONS)).toEqual(['bloodworms']);
      expect(feedBloodworms(above)).toEqual(['flakes', 'bloodworms']);
      expect(algaeAfterCleanup(above)).toBeGreaterThan(
        algaeAfterCleanup(SETTLED_FOOD_MIN_PORTIONS),
      );
    });

    it('keeps treating food as any type on a tank that has no record of it', () => {
      const params = env.chemistryParams;
      const legacy = tank(plecos(1), { uneatenFood: 2 });
      const fed = applyCare(
        legacy,
        { type: 'feed', food: 'bloodworms', portion: 1 },
        'freshwater',
        params,
        T0,
      );
      if (!fed.ok) throw new Error(fed.reason);
      expect(fed.value.water.uneatenFoodTypes).toBeUndefined();
    });
  });
});
