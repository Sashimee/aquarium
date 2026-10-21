import { TANK_SIZES, type Collider } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import {
  algaeAreaPerHour,
  algaeGrazer,
  cleanupSurfaces,
  crewCleanup,
  isScavenger,
  scavengeSweepPerHour,
  type CleanupInput,
  type CrewMember,
} from './crew.ts';
import { FEEDING } from './feeding.ts';
import { FOOD_PARTICLES } from './food.ts';
import {
  ARCHETYPES,
  bronzeCorydoras,
  cherryShrimp,
  FoodRain,
  neonTetra,
  otocinclus,
  REEF_DECOR,
  REEF_TANK,
  SHOW_TANK,
  spawnMany,
  yellowTang,
} from './fixtures.ts';
import { toSimSpecies, type SimSpecies, type SpeciesInput } from './species.ts';
import { STEP_DT, World, type FishSpawn } from './world.ts';

const LONG = 120_000;

const SPECIES: ReadonlyMap<string, SimSpecies> = new Map(
  [...ARCHETYPES, cherryShrimp].map((s) => [s.id, toSimSpecies(s)]),
);

function sim(input: SpeciesInput): SimSpecies {
  const sp = SPECIES.get(input.id);
  if (sp === undefined) throw new Error(`no species ${input.id}`);
  return sp;
}

const standard = TANK_SIZES.standard.dimensions;
const SURFACES = cleanupSurfaces({
  width: standard.length,
  depth: standard.depth,
  height: standard.height,
});

function crew(species: SpeciesInput, count: number, extra: Partial<CrewMember> = {}): CrewMember[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${species.id}-${i}`,
    species: species.id,
    alive: true,
    ...extra,
  }));
}

function input(over: Partial<CleanupInput>): CleanupInput {
  return {
    crew: [],
    species: SPECIES,
    algae: 0.5,
    uneatenFood: 4,
    dtHours: 1 / 6,
    litFraction: 1,
    surfaces: SURFACES,
    ...over,
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((s, v) => s + v, 0);
}

describe('crew roles', () => {
  it('sorts the archetypes into grazers and scavengers', () => {
    expect(algaeGrazer(sim(cherryShrimp))).toBe('surface');
    expect(algaeGrazer(sim(otocinclus))).toBe('glass');
    expect(algaeGrazer(sim(yellowTang))).toBe('rock');
    expect(algaeGrazer(sim(neonTetra))).toBe('none');
    expect(isScavenger(sim(cherryShrimp))).toBe(true);
    expect(isScavenger(sim(bronzeCorydoras))).toBe(true);
    expect(isScavenger(sim(neonTetra))).toBe(false);
    expect(isScavenger(sim(otocinclus))).toBe(false);
  });

  it('gives no rate to a fish that neither grazes nor scavenges', () => {
    expect(algaeAreaPerHour(sim(neonTetra))).toBe(0);
    expect(scavengeSweepPerHour(sim(neonTetra))).toBe(0);
    expect(scavengeSweepPerHour(sim(otocinclus))).toBe(0);
  });

  it('scales a grazer’s rate with the square of its length, as its swath and speed both grow', () => {
    const sp = sim(cherryShrimp);
    expect(algaeAreaPerHour(sp, 2 * sp.bodyLength)).toBeCloseTo(4 * algaeAreaPerHour(sp), 12);
  });

  it('measures the grazable glass and substrate of a tank', () => {
    const s = cleanupSurfaces({ width: 1, depth: 0.5, height: 0.4 });
    expect(s.floorM2).toBeCloseTo(0.5, 12);
    expect(s.grazableM2).toBeCloseTo(0.5 + 2 * 1.5 * 0.4, 12);
    expect(() => cleanupSurfaces({ width: 0, depth: 0.5, height: 0.4 })).toThrow(/width/);
  });
});

describe('crewCleanup', () => {
  it('grazes nothing in a tank without algae, and still scavenges', () => {
    const r = crewCleanup(input({ crew: crew(cherryShrimp, 4), algae: 0 }));
    expect(r.algaeGrazed).toBe(0);
    expect(r.foodEaten).toBeGreaterThan(0);
    expect(r.perFish.every((f) => f.algae === 0)).toBe(true);
  });

  it('eats nothing when no food has settled, and still grazes', () => {
    const r = crewCleanup(input({ crew: crew(cherryShrimp, 4), uneatenFood: 0 }));
    expect(r.foodEaten).toBe(0);
    expect(r.algaeGrazed).toBeGreaterThan(0);
    expect(r.perFish.every((f) => f.food === 0)).toBe(true);
  });

  it('does nothing without a crew or over no time', () => {
    expect(crewCleanup(input({ crew: [] }))).toEqual({ algaeGrazed: 0, foodEaten: 0, perFish: [] });
    const still = crewCleanup(input({ crew: crew(cherryShrimp, 3), dtHours: 0 }));
    expect(still.algaeGrazed).toBe(0);
    expect(still.foodEaten).toBe(0);
    expect(still.perFish).toEqual([]);
  });

  it('never takes more than is there, however large the crew, and more crew take more', () => {
    let lastAlgae = 0;
    let lastFood = 0;
    for (const n of [1, 4, 16, 64, 500]) {
      const r = crewCleanup(
        input({
          crew: [...crew(cherryShrimp, n), ...crew(bronzeCorydoras, n), ...crew(otocinclus, n)],
          dtHours: 24,
        }),
      );
      expect(r.algaeGrazed).toBeLessThanOrEqual(0.5);
      expect(r.foodEaten).toBeLessThanOrEqual(4 + 1e-12);
      expect(r.algaeGrazed).toBeGreaterThanOrEqual(lastAlgae);
      if (n === 1) expect(r.algaeGrazed).toBeLessThan(0.5);
      expect(r.foodEaten).toBeGreaterThanOrEqual(lastFood);
      expect(sum(r.perFish.map((f) => f.algae))).toBeCloseTo(r.algaeGrazed, 12);
      expect(sum(r.perFish.map((f) => f.food))).toBeCloseTo(r.foodEaten, 12);
      lastAlgae = r.algaeGrazed;
      lastFood = r.foodEaten;
    }
    expect(lastFood).toBeCloseTo(4, 9);
  });

  it('feeds no scavenger past its gut, passing what a full one leaves to hungrier ones', () => {
    const full = crewCleanup(
      input({ crew: crew(bronzeCorydoras, 3, { hunger: 0 }), dtHours: 1 / 6, uneatenFood: 10 }),
    );
    const room = 3 * (1 - Math.exp(-600 / FEEDING.gastricEvacuationTauS));
    expect(full.foodEaten).toBeGreaterThan(0);
    expect(full.foodEaten).toBeLessThanOrEqual(room + 1e-12);

    const mixed = crewCleanup(
      input({
        crew: [
          { id: 'fed', species: bronzeCorydoras.id, alive: true, hunger: 0 },
          { id: 'starving', species: bronzeCorydoras.id, alive: true, hunger: 1 },
        ],
        uneatenFood: 1.5,
      }),
    );
    const fed = mixed.perFish.find((f) => f.id === 'fed')?.food ?? 0;
    const starving = mixed.perFish.find((f) => f.id === 'starving')?.food ?? 0;
    expect(starving).toBeCloseTo(FEEDING.satiationPortions, 9);
    expect(fed).toBeLessThan(0.05);
    expect(mixed.foodEaten).toBeCloseTo(fed + starving, 12);
  });

  it('counts nothing for a dead crew member and leaves the living ones as they were', () => {
    const living = crew(cherryShrimp, 3);
    const dead: CrewMember = { id: 'dead', species: cherryShrimp.id, alive: false };
    const without = crewCleanup(input({ crew: living }));
    const withDead = crewCleanup(input({ crew: [...living, dead] }));
    expect(withDead).toEqual(without);
    expect(withDead.perFish.some((f) => f.id === 'dead')).toBe(false);
    const allDead = crewCleanup(input({ crew: [dead, { ...dead, id: 'dead-2' }] }));
    expect(allDead).toEqual({ algaeGrazed: 0, foodEaten: 0, perFish: [] });
  });

  it('is pure: the same input gives the same result and is left unchanged', () => {
    const members = [...crew(cherryShrimp, 5, { hunger: 0.3 }), ...crew(otocinclus, 2)];
    const a = input({ crew: members, dtHours: 3 });
    const copy = JSON.stringify(a.crew);
    expect(crewCleanup(a)).toEqual(crewCleanup(a));
    expect(JSON.stringify(a.crew)).toBe(copy);
  });

  it('gives one long step the same algae as many short ones', () => {
    const members = crew(otocinclus, 3);
    const once = crewCleanup(input({ crew: members, algae: 0.8, dtHours: 6 })).algaeGrazed;
    let cover = 0.8;
    for (let k = 0; k < 36; k++) {
      cover -= crewCleanup(input({ crew: members, algae: cover, dtHours: 1 / 6 })).algaeGrazed;
    }
    expect(0.8 - cover).toBeCloseTo(once, 12);
  });

  it('keeps a lit tank’s algae in check with a few grazers, without scrubbing it clean in an hour', () => {
    const r = crewCleanup(input({ crew: crew(otocinclus, 3), algae: 1, dtHours: 1 }));
    expect(r.algaeGrazed).toBeGreaterThan(0.01);
    expect(r.algaeGrazed).toBeLessThan(0.5);
  });

  it('rejects input it cannot account for', () => {
    expect(() => crewCleanup(input({ algae: 1.2 }))).toThrow(/algae/);
    expect(() => crewCleanup(input({ uneatenFood: -1 }))).toThrow(/uneatenFood/);
    expect(() => crewCleanup(input({ dtHours: Number.NaN }))).toThrow(/dtHours/);
    expect(() =>
      crewCleanup(input({ crew: [{ id: 'x', species: 'nerite-snail', alive: true }] })),
    ).toThrow(/unknown species "nerite-snail"/);
    expect(() => crewCleanup(input({ crew: crew(cherryShrimp, 1, { hunger: 2 }) }))).toThrow(
      /hunger/,
    );
    expect(() => crewCleanup(input({ crew: crew(cherryShrimp, 1, { bodyLengthM: 0 }) }))).toThrow(
      /bodyLengthM/,
    );
    expect(() => crewCleanup(input({ surfaces: { grazableM2: 0, floorM2: 1 } }))).toThrow(
      /surfaces/,
    );
  });
});

function world(
  fish: FishSpawn[],
  seed = 3,
  tank: { width: number; height: number; depth: number } = SHOW_TANK,
  decor: readonly Collider[] = [],
): World {
  return new World({ seed, tank, species: [...ARCHETYPES, cherryShrimp], decor, fish });
}

function run(w: World, steps: number, rain?: FoodRain): void {
  for (let t = 0; t < steps; t++) {
    rain?.feed(w);
    w.step();
    rain?.eat(w.takeAteEvents());
  }
}

describe('crew in a running world', { timeout: LONG }, () => {
  it('grazes nothing until it is told there is algae', () => {
    const w = world(spawnMany(cherryShrimp.id, 4));
    run(w, 300);
    expect(w.takeCrewTally()).toEqual([]);
    expect(() => w.setAlgae(-0.1)).toThrow(/algae/);
    expect(() => w.setAlgae(Number.NaN)).toThrow(/algae/);
  });

  it('clears film in proportion to the cover without changing how the crew moves', () => {
    const half = world(spawnMany(cherryShrimp.id, 4));
    const full = world(spawnMany(cherryShrimp.id, 4));
    half.setAlgae(0.5);
    full.setAlgae(1);
    run(half, 600);
    run(full, 600);
    expect(Array.from(half.position)).toEqual(Array.from(full.position));
    const a = half.takeCrewTally();
    const b = full.takeCrewTally();
    expect(a.map((e) => e.fishId)).toEqual(b.map((e) => e.fishId));
    expect(a.length).toBe(4);
    a.forEach((e, k) => {
      expect(e.algaeM2).toBeGreaterThan(0);
      expect(e.algaeM2 * 2).toBeCloseTo(b[k]?.algaeM2 ?? 0, 12);
      expect(e.settledPortions).toBe(0);
    });
    expect(full.takeCrewTally()).toEqual([]);
  });

  it('grazes at the rate the offline model gives the lifecycle', () => {
    const cases = [
      { species: cherryShrimp, tank: SHOW_TANK, decor: [] },
      { species: otocinclus, tank: SHOW_TANK, decor: [] },
      { species: yellowTang, tank: REEF_TANK, decor: REEF_DECOR },
    ] as const;
    for (const { species, tank, decor } of cases) {
      const w = world(spawnMany(species.id, 6), 3, tank, decor);
      w.setAlgae(1);
      const steps = 30 * 300;
      run(w, steps);
      const total = sum(w.takeCrewTally().map((e) => e.algaeM2));
      const perHour = total / 6 / ((steps * STEP_DT) / 3600);
      const offline = algaeAreaPerHour(sim(species));
      expect(perHour, species.id).toBeGreaterThan(0.5 * offline);
      expect(perHour, species.id).toBeLessThan(2 * offline);
    }
  });

  it('never grazes with a fish that has no grazing habit', () => {
    const w = world(spawnMany(neonTetra.id, 6));
    w.setAlgae(1);
    run(w, 600);
    expect(w.takeCrewTally()).toEqual([]);
  });

  it('lets a cory smell a settled pellet behind it, out of sight, and tallies it as scavenged', () => {
    const w = world([]);
    const ground = w.basin.ground(0, 0);
    w.addFish(
      { id: 'cory', species: bronzeCorydoras.id },
      {
        position: [0.1, ground + 0.02, 0],
        heading: Math.PI / 2,
      },
    );
    const behind = 1.6 * sim(bronzeCorydoras).perceptionRange;
    expect(behind).toBeLessThan(
      FEEDING.scavengerChemoRangeFactor * sim(bronzeCorydoras).perceptionRange,
    );
    const rain = new FoodRain(SHOW_TANK);
    rain.place('pellets', 0.1 - behind, ground + 0.004, 0);
    let first = -1;
    for (let t = 0; t < 30 * 40 && rain.count > 0; t++) {
      rain.feed(w);
      w.step();
      if (first < 0 && (w.behaviour.feeding.target[0] ?? -1) >= 0) first = t;
      rain.eat(w.takeAteEvents());
    }
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(15);
    expect(rain.count).toBe(0);
    const tally = w.takeCrewTally();
    expect(tally).toHaveLength(1);
    expect(tally[0]?.fishId).toBe('cory');
    expect(tally[0]?.settledPortions).toBeCloseTo(rain.eaten, 12);
  });

  it('turns cories round onto pellets they smell behind them, past their braking distance', () => {
    const w = world([]);
    const ground = w.basin.ground(0, 0);
    const length = sim(bronzeCorydoras).bodyLength;
    const starts: [number, number][] = [
      [-0.3, 0.05],
      [-0.25, -0.08],
    ];
    starts.forEach(([x, z], n) =>
      w.addFish(
        { id: `cory-${n}`, species: bronzeCorydoras.id },
        { position: [x, ground + 0.02, z], heading: Math.PI / 2 },
      ),
    );
    const rain = new FoodRain(SHOW_TANK);
    const behind: [number, number][] = [
      [-0.55, 0.1],
      [-0.56, -0.12],
    ];
    for (const [x, z] of behind) {
      expect(x - (starts[0]?.[0] ?? 0)).toBeLessThan(-FEEDING.brakeBodyLengths * length);
      rain.place('pellets', x, ground + 0.004, z);
    }
    for (const [x, z] of [
      [0.05, 0.15],
      [0.1, -0.15],
      [0.12, 0.02],
    ] as const) {
      rain.place('pellets', x, ground + 0.004, z);
    }
    const eaten = new Set<number>();
    for (let t = 0; t < 30 * 45 && rain.count > 0; t++) {
      rain.feed(w);
      w.step();
      const ate = w.takeAteEvents();
      for (const e of ate) eaten.add(e.foodId);
      rain.eat(ate);
    }
    expect(rain.count).toBe(0);
    expect(eaten.size).toBe(5);
  });

  it('lets a shrimp walk to settled food it smells beyond its sight', () => {
    const w = world([]);
    const ground = w.basin.ground(0, 0);
    w.addFish(
      { id: 'shrimp', species: cherryShrimp.id },
      {
        position: [0.15, ground + 0.01, 0],
        heading: Math.PI / 2,
      },
    );
    const rain = new FoodRain(SHOW_TANK);
    rain.place('pellets', 0.15 - 1.5 * sim(cherryShrimp).perceptionRange, ground + 0.004, 0);
    run(w, 30 * 60, rain);
    expect(rain.eaten).toBeGreaterThan(0);
    const tally = w.takeCrewTally();
    expect(tally.find((e) => e.fishId === 'shrimp')?.settledPortions).toBeCloseTo(rain.eaten, 12);
  });

  it('does not count food taken in open water as scavenged', () => {
    const w = world(spawnMany(neonTetra.id, 8));
    const rain = new FoodRain(SHOW_TANK);
    rain.sprinkle('flakes', 30, 0, 0, 0.2, 20);
    run(w, 30 * 15, rain);
    expect(rain.eaten).toBeGreaterThan(0);
    expect(w.takeCrewTally()).toEqual([]);
  });

  it('keeps a dead crew member’s grazing from before it died and adds none after', () => {
    const w = world(spawnMany(cherryShrimp.id, 3));
    w.setAlgae(1);
    run(w, 600);
    w.removeFish('cherry-shrimp-1');
    const before = w.takeCrewTally();
    expect(before.map((e) => e.fishId)).toContain('cherry-shrimp-1');
    run(w, 600);
    const after = w.takeCrewTally();
    expect(after.map((e) => e.fishId)).not.toContain('cherry-shrimp-1');
    expect(after.length).toBe(2);
  });

  it('keeps a crowded crew within the food there is', () => {
    const w = world([...spawnMany(cherryShrimp.id, 24), ...spawnMany(bronzeCorydoras.id, 12)]);
    w.setAlgae(0.3);
    const rain = new FoodRain(SHOW_TANK);
    for (let k = 0; k < 20; k++)
      rain.place('pellets', -0.5 + k * 0.05, w.basin.ground(0, 0) + 0.004, 0);
    const placed = 20 * FOOD_PARTICLES.pellets.portion;
    run(w, 30 * 60, rain);
    const tally = w.takeCrewTally();
    const scavenged = sum(tally.map((e) => e.settledPortions));
    expect(scavenged).toBeGreaterThan(0);
    expect(scavenged).toBeLessThanOrEqual(rain.eaten + 1e-12);
    expect(rain.eaten).toBeLessThanOrEqual(placed + 1e-9);
    expect(new Set(tally.map((e) => e.fishId)).size).toBe(tally.length);
  });

  it('gives the same tally and trajectory for the same seed', () => {
    const go = () => {
      const w = world(
        [
          ...spawnMany(cherryShrimp.id, 6),
          ...spawnMany(otocinclus.id, 3),
          ...spawnMany(bronzeCorydoras.id, 4),
        ],
        9,
      );
      w.setAlgae(0.7);
      const rain = new FoodRain(SHOW_TANK);
      rain.sprinkle('pellets', 12, 0, 0, 0.3);
      const tallies = [];
      for (let k = 0; k < 6; k++) {
        run(w, 300, rain);
        tallies.push(w.takeCrewTally());
      }
      return { tallies, position: Array.from(w.position) };
    };
    const a = go();
    const b = go();
    expect(a.tallies.flat().length).toBeGreaterThan(0);
    expect(a.tallies.flat().some((e) => e.settledPortions > 0)).toBe(true);
    expect(b).toEqual(a);
  });
});
