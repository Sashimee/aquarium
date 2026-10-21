import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  chemistryParametersSchema,
  DEFAULT_EQUIPMENT,
  newTankChemistry,
  speciesContentSchema,
  type Water,
} from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { cleanupSurfaces } from '../src/crew.ts';
import { toSimSpecies, type SimSpecies } from '../src/species.ts';
import {
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
const contents = ['nerite-snail', 'hermit-crab'].map((id) =>
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
});
