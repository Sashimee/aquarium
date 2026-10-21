import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { speciesContentSchema } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import {
  cleanupSurfaces,
  crewCleanup,
  type CleanupInput,
  type CrewMember,
  type CrewTally,
} from './crew.ts';
import { FOOD_PARTICLES, FOOD_TYPES } from './food.ts';
import { FoodRain, REEF_ANCHORS, REEF_DECOR, REEF_TANK, SHOW_TANK, spawnMany } from './fixtures.ts';
import { FishState } from './snapshot.ts';
import { toSimSpecies, type SimSpecies, type SpeciesInput } from './species.ts';
import { World, type FishSpawn, type WorldConfig } from './world.ts';

const LONG = 120_000;
const contentDir = join(import.meta.dirname, '../../../content/species');

function content(id: string): SpeciesInput {
  const raw: unknown = JSON.parse(readFileSync(join(contentDir, `${id}.json`), 'utf8'));
  return speciesContentSchema.parse(raw);
}

const SNAIL = content('nerite-snail');
const CRAB = content('hermit-crab');
const SPECIES: readonly SpeciesInput[] = [SNAIL, CRAB];
const SIM: ReadonlyMap<string, SimSpecies> = new Map(SPECIES.map((s) => [s.id, toSimSpecies(s)]));
const SURFACES = cleanupSurfaces(REEF_TANK);

function reef(fish: FishSpawn[], seed: number): WorldConfig {
  return {
    seed,
    tank: REEF_TANK,
    species: SPECIES,
    decor: REEF_DECOR,
    anchors: REEF_ANCHORS,
    fish,
  };
}

function bare(seed: number): World {
  return new World({ seed, tank: SHOW_TANK, species: SPECIES, fish: [] });
}

function run(w: World, steps: number, rain?: FoodRain): void {
  for (let t = 0; t < steps; t++) {
    rain?.feed(w);
    w.step();
    rain?.eat(w.takeAteEvents());
  }
}

const total = (tally: readonly CrewTally[], key: 'algaeM2' | 'settledPortions'): number =>
  tally.reduce((s, e) => s + e[key], 0);

const members = (ids: readonly [string, string][]): CrewMember[] =>
  ids.map(([id, species]) => ({ id, species, alive: true, hunger: 1 }));

function cleanup(over: Partial<CleanupInput> = {}): ReturnType<typeof crewCleanup> {
  return crewCleanup({
    crew: members([
      ['snail', SNAIL.id],
      ['crab', CRAB.id],
    ]),
    species: SIM,
    algae: 0.6,
    uneatenFood: 2,
    dtHours: 1,
    litFraction: 1,
    surfaces: SURFACES,
    ...over,
  });
}

function crabFacingPellet(seed: number): { w: World; mouth: [number, number, number] } {
  const w = bare(seed);
  const ground = w.basin.ground(0, 0);
  w.addFish({ id: 'crab', species: CRAB.id }, { position: [0, ground + 0.01, 0], heading: 0 });
  run(w, 30);
  const length = w.bodyLength[0] ?? 0;
  const mouth: [number, number, number] = [
    (w.position[0] ?? 0) + (w.forward[0] ?? 0) * 0.4 * length,
    w.position[1] ?? 0,
    (w.position[2] ?? 0) + (w.forward[2] ?? 0) * 0.4 * length,
  ];
  return { w, mouth };
}

describe('the clean-up crew from content', () => {
  it('loads the snail as a glass, rock and sand grazer and the crab as a sand and rock one', () => {
    const snail = SIM.get(SNAIL.id)?.walking;
    const crab = SIM.get(CRAB.id)?.walking;
    expect(snail?.escape).toBe('withdraw');
    expect(crab?.escape).toBe('withdraw');
    expect(snail?.biofilmGrazer).toBe(true);
    expect(crab?.biofilmGrazer).toBe(true);
    expect([snail?.glass, snail?.decor, snail?.substrate]).toEqual([true, true, true]);
    expect([crab?.glass, crab?.decor, crab?.substrate]).toEqual([false, true, true]);
  });
});

describe('crewCleanup for snails and crabs', () => {
  it('takes algae off and lowers it further the longer the crew grazes', () => {
    const hour = cleanup({ uneatenFood: 0 });
    const day = cleanup({ uneatenFood: 0, dtHours: 24 });
    expect(hour.algaeGrazed).toBeGreaterThan(0);
    expect(day.algaeGrazed).toBeGreaterThan(hour.algaeGrazed);
    expect(day.algaeGrazed).toBeLessThan(0.6);
    expect(hour.perFish.map((f) => f.id)).toEqual(['snail', 'crab']);
  });

  it('grazes and scavenges nothing in the dark, and in proportion to the lit share of the step', () => {
    const dark = cleanup({ litFraction: 0 });
    expect(dark.algaeGrazed).toBe(0);
    expect(dark.foodEaten).toBe(0);
    expect(dark.perFish).toEqual([]);
    const lit = cleanup({ dtHours: 2, litFraction: 1 });
    const half = cleanup({ dtHours: 4, litFraction: 0.5 });
    expect(half.algaeGrazed).toBeCloseTo(lit.algaeGrazed, 12);
  });

  it('handles a tank with no algae and no food', () => {
    const r = cleanup({ algae: 0, uneatenFood: 0 });
    expect(r).toEqual({ algaeGrazed: 0, foodEaten: 0, perFish: [] });
  });

  it('rejects a lit share outside 0 to 1', () => {
    for (const litFraction of [-0.1, 1.1, Number.NaN]) {
      expect(() => cleanup({ litFraction })).toThrow(/litFraction/);
    }
  });
});

describe('snails and crabs in a running world', { timeout: LONG }, () => {
  it('graze the film down when the tally is fed back as algae cover', () => {
    const w = new World(reef([...spawnMany(SNAIL.id, 30), ...spawnMany(CRAB.id, 20, 'crab')], 4));
    let cover = 0.8;
    const covers = [cover];
    for (let minute = 0; minute < 5; minute++) {
      w.setAlgae(cover);
      run(w, 30 * 60);
      const grazed = total(w.takeCrewTally(), 'algaeM2') / SURFACES.grazableM2;
      expect(grazed).toBeGreaterThan(0);
      cover = Math.max(0, cover - grazed);
      covers.push(cover);
    }
    for (let k = 1; k < covers.length; k++) {
      expect(covers[k]).toBeLessThan(covers[k - 1] ?? 0);
    }
  });

  it('graze nothing without algae and scavenge nothing without food', () => {
    const w = new World(reef([...spawnMany(SNAIL.id, 4), ...spawnMany(CRAB.id, 4, 'crab')], 2));
    w.setAlgae(0);
    run(w, 30 * 60);
    expect(w.takeCrewTally()).toEqual([]);
    const rain = new FoodRain(REEF_TANK);
    run(w, 30 * 30, rain);
    expect(rain.eaten).toBe(0);
    expect(w.takeCrewTally()).toEqual([]);
  });

  it('leave a pellet alone while it falls past them and eat it once it has sunk', () => {
    for (const seed of [1, 2, 3]) {
      const { w, mouth } = crabFacingPellet(seed);
      const rain = new FoodRain(SHOW_TANK);
      const id = rain.place('pellets', mouth[0], mouth[1] + 0.03, mouth[2], 0, 0.008);
      const ground = w.basin.ground(mouth[0], mouth[2]);
      let landedAt = -1;
      for (let t = 0; t < 30 * 60 && rain.eaten === 0; t++) {
        const before = rain.position(id)?.[1] ?? 0;
        rain.feed(w);
        w.step();
        rain.eat(w.takeAteEvents());
        const after = rain.position(id)?.[1];
        if (landedAt < 0 && after !== undefined && after === before) landedAt = t;
        if (landedAt < 0) expect(rain.eaten, `seed ${seed}, still falling`).toBe(0);
      }
      expect(landedAt, `seed ${seed}`).toBeGreaterThan(0);
      expect(rain.position(id)?.[1] ?? ground, `seed ${seed}`).toBeLessThan(ground + 0.01);
      expect(rain.eaten, `seed ${seed}`).toBeGreaterThan(0);
      expect(total(w.takeCrewTally(), 'settledPortions')).toBeCloseTo(rain.eaten, 12);
    }
  });

  it('let go of a pellet that is lifted off the surface after they chose it', () => {
    for (const seed of [1, 2, 3]) {
      const { w, mouth } = crabFacingPellet(seed);
      const ground = w.basin.ground(mouth[0], mouth[2]);
      const ahead = (w.bodyLength[0] ?? 0) * 3;
      const px = mouth[0] + (w.forward[0] ?? 0) * ahead;
      const pz = mouth[2] + (w.forward[2] ?? 0) * ahead;
      const frame = (x: number, y: number, z: number): Float32Array =>
        new Float32Array([1, x, y, z, FOOD_TYPES.indexOf('pellets')]);
      const start = Math.hypot((w.position[0] ?? 0) - px, (w.position[2] ?? 0) - pz);
      let closing = 0;
      for (; closing < 30 * 20; closing++) {
        w.setFood(frame(px, ground + 0.004, pz));
        w.step();
        const d = Math.hypot((w.position[0] ?? 0) - px, (w.position[2] ?? 0) - pz);
        if (d < start * 0.6) break;
      }
      expect(closing, `seed ${seed}, never went for the landed pellet`).toBeLessThan(30 * 20);
      let ate = 0;
      for (let t = 0; t < 30 * 20; t++) {
        const length = w.bodyLength[0] ?? 0;
        w.setFood(
          frame(
            (w.position[0] ?? 0) + (w.forward[0] ?? 0) * 0.4 * length,
            (w.position[1] ?? 0) + 0.012,
            (w.position[2] ?? 0) + (w.forward[2] ?? 0) * 0.4 * length,
          ),
        );
        w.step();
        ate += w.takeAteEvents().length;
      }
      expect(ate, `seed ${seed}`).toBe(0);
      expect(w.takeCrewTally()).toEqual([]);
    }
  });

  it('never take a pellet held in the water above them', () => {
    const { w, mouth } = crabFacingPellet(5);
    const rain = new FoodRain(SHOW_TANK);
    rain.place('pellets', mouth[0], mouth[1] + 0.012, mouth[2], 0, 0);
    run(w, 30 * 60, rain);
    expect(rain.eaten).toBe(0);
    expect(w.takeCrewTally()).toEqual([]);
  });

  it('share one pellet among many crabs without eating more than it holds', () => {
    const w = bare(8);
    const ground = w.basin.ground(0, 0);
    const n = 10;
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n;
      w.addFish(
        { id: `crab-${k}`, species: CRAB.id },
        {
          position: [0.08 * Math.cos(a), ground + 0.01, 0.08 * Math.sin(a)],
          heading: Math.atan2(-Math.cos(a), -Math.sin(a)),
        },
      );
    }
    const rain = new FoodRain(SHOW_TANK);
    rain.place('pellets', 0, ground + 0.004, 0);
    const portion = FOOD_PARTICLES.pellets.portion;
    let worst = Infinity;
    for (let t = 0; t < 30 * 120; t++) {
      rain.feed(w);
      w.step();
      rain.eat(w.takeAteEvents());
      for (let i = 0; i < w.count; i++) worst = Math.min(worst, w.bodyClearance(i));
    }
    const tally = w.takeCrewTally();
    expect(rain.eaten).toBeCloseTo(portion, 9);
    expect(rain.count).toBe(0);
    expect(total(tally, 'settledPortions')).toBeCloseTo(portion, 9);
    expect(tally.length).toBeGreaterThanOrEqual(1);
    expect(tally.length).toBeLessThan(n);
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
    for (let i = 0; i < w.count; i++) expect(w.walkers.attached[i]).toBe(1);
  });

  it('rest at night, grazing and scavenging nothing until the lights come on', () => {
    const w = new World(reef([...spawnMany(SNAIL.id, 4), ...spawnMany(CRAB.id, 4, 'crab')], 6));
    w.setAlgae(1);
    w.setLight(0);
    run(w, 30 * 120);
    w.takeCrewTally();
    const rain = new FoodRain(REEF_TANK);
    for (let i = 0; i < w.count; i++) {
      rain.place(
        'pellets',
        w.position[i * 3] ?? 0,
        w.basin.ground(0, 0) + 0.004,
        w.position[i * 3 + 2] ?? 0,
      );
    }
    let resting = 0;
    const steps = 30 * 60;
    for (let t = 0; t < steps; t++) {
      rain.feed(w);
      w.step();
      rain.eat(w.takeAteEvents());
      for (let i = 0; i < w.count; i++) if (w.state[i] === FishState.Rest) resting++;
    }
    expect(resting).toBeGreaterThan(0.95 * steps * w.count);
    expect(rain.eaten).toBe(0);
    expect(w.takeCrewTally()).toEqual([]);
    w.setLight(1);
    run(w, 30 * 120, rain);
    const day = w.takeCrewTally();
    expect(total(day, 'algaeM2')).toBeGreaterThan(0);
    expect(rain.eaten).toBeGreaterThan(0);
  });

  it('give the same tally and trajectory for the same seed and a different one for another', () => {
    const go = (seed: number) => {
      const w = new World(
        reef([...spawnMany(SNAIL.id, 5), ...spawnMany(CRAB.id, 5, 'crab')], seed),
      );
      w.setAlgae(0.5);
      const rain = new FoodRain(REEF_TANK);
      rain.sprinkle('pellets', 10, 0, 0, 0.3);
      const tallies: (readonly CrewTally[])[] = [];
      for (let k = 0; k < 5; k++) {
        run(w, 30 * 20, rain);
        tallies.push(w.takeCrewTally());
      }
      return { tallies, position: Array.from(w.position), eaten: rain.eaten };
    };
    const a = go(21);
    expect(a.tallies.flat().some((e) => e.algaeM2 > 0)).toBe(true);
    expect(go(21)).toEqual(a);
    expect(go(22).position).not.toEqual(a.position);
  });
});
