import { describe, expect, it } from 'vitest';
import {
  algaeAreaPerHour,
  algaeGrazer,
  cleanupSurfaces,
  crewCleanup,
  isScavenger,
  scavengeSweepPerHour,
} from './crew.ts';
import {
  cherryShrimp,
  FoodRain,
  hermitCrab,
  neriteSnail,
  REEF_ANCHORS,
  REEF_DECOR,
  REEF_TANK,
  SHOW_DECOR,
  SHOW_TANK,
  spawnMany,
} from './fixtures.ts';
import type { Sdf } from './sdf.ts';
import { FishState } from './snapshot.ts';
import { toSimSpecies, type SimSpecies, type SpeciesInput } from './species.ts';
import { WALK } from './walk.ts';
import { STEP_DT, World, type FishSpawn, type WorldConfig } from './world.ts';

const LONG = 120_000;
const SHELLED = [neriteSnail, hermitCrab] as const;
const SPECIES: readonly SpeciesInput[] = [...SHELLED, cherryShrimp];
const SIM: ReadonlyMap<string, SimSpecies> = new Map(SPECIES.map((s) => [s.id, toSimSpecies(s)]));

function sim(input: SpeciesInput): SimSpecies {
  const sp = SIM.get(input.id);
  if (sp === undefined) throw new Error(`no species ${input.id}`);
  return sp;
}

function showWorld(fish: FishSpawn[], seed = 5): World {
  return new World({ seed, tank: SHOW_TANK, species: SPECIES, decor: SHOW_DECOR, fish });
}

function reefConfig(fish: FishSpawn[], seed = 5): WorldConfig {
  return {
    seed,
    tank: REEF_TANK,
    species: SPECIES,
    decor: REEF_DECOR,
    anchors: REEF_ANCHORS,
    fish,
  };
}

function run(w: World, steps: number, rain?: FoodRain): void {
  for (let t = 0; t < steps; t++) {
    rain?.feed(w);
    w.step();
    rain?.eat(w.takeAteEvents());
  }
}

function distanceTo(sdf: Sdf, w: World, i: number): number {
  const o = i * 3;
  return sdf.sample(
    w.position[o] ?? 0,
    w.position[o + 1] ?? 0,
    w.position[o + 2] ?? 0,
    new Float64Array(3),
  );
}

/** The highest point of hard decor above (x, z), found by stepping down from the waterline. */
function decorTop(w: World, x: number, z: number): number {
  const decor = w.decorSdf;
  if (decor === null) throw new Error('world has no hard decor');
  const g = new Float64Array(3);
  for (let y = w.basin.maxY; y > w.basin.ground(x, z); y -= 0.001) {
    if (decor.sample(x, y, z, g) <= 0) return y;
  }
  throw new Error(`no decor under (${x}, ${z})`);
}

describe('snails and hermit crabs as walkers', () => {
  it('load as walkers that withdraw instead of tail-flipping', () => {
    for (const s of SHELLED) {
      const w = sim(s).walking;
      expect(w, s.id).not.toBeNull();
      expect(w?.escape, s.id).toBe('withdraw');
      expect(w?.flipSpeed, s.id).toBe(0);
      expect(w?.withdrawMinS, s.id).toBeLessThanOrEqual(w?.withdrawMaxS ?? 0);
    }
    expect(sim(neriteSnail).walking?.legPairs).toBe(0);
    expect(sim(neriteSnail).walking?.glass).toBe(true);
    expect(sim(hermitCrab).walking?.glass).toBe(false);
    expect(sim(cherryShrimp).walking?.escape).toBe('tail-flip');
  });

  it('graze surface film and scavenge settled food in the offline model', () => {
    for (const s of SHELLED) {
      expect(algaeGrazer(sim(s)), s.id).toBe('surface');
      expect(isScavenger(sim(s)), s.id).toBe(true);
      expect(algaeAreaPerHour(sim(s)), s.id).toBeGreaterThan(0);
      expect(scavengeSweepPerHour(sim(s)), s.id).toBeGreaterThan(0);
    }
    // A snail glides at a fifth of a hermit crab's pace, so it sweeps less floor for food.
    expect(scavengeSweepPerHour(sim(neriteSnail))).toBeLessThan(
      scavengeSweepPerHour(sim(hermitCrab)),
    );
    const result = crewCleanup({
      crew: [
        { id: 'snail', species: neriteSnail.id, alive: true },
        { id: 'crab', species: hermitCrab.id, alive: true },
      ],
      species: SIM,
      algae: 0.6,
      uneatenFood: 2,
      dtHours: 1,
      surfaces: cleanupSurfaces({ width: 0.6, depth: 0.3, height: 0.36 }),
    });
    expect(result.algaeGrazed).toBeGreaterThan(0);
    expect(result.foodEaten).toBeGreaterThan(0);
    expect(result.perFish.map((f) => f.id)).toEqual(['snail', 'crab']);
    for (const f of result.perFish) {
      expect(f.algae, f.id).toBeGreaterThan(0);
      expect(f.food, f.id).toBeGreaterThan(0);
    }
  });

  it('reject a non-swimmer that tail-flips and a swimmer that withdraws', () => {
    const snailWalk = neriteSnail.locomotion.walking;
    const shrimpWalk = cherryShrimp.locomotion.walking;
    if (snailWalk === undefined || shrimpWalk === undefined)
      throw new Error('fixture lost walking');
    const withWalking = (base: SpeciesInput, walking: typeof snailWalk): SpeciesInput => ({
      ...base,
      id: 'variant',
      locomotion: { ...base.locomotion, walking },
    });
    expect(() =>
      toSimSpecies(withWalking(neriteSnail, { ...snailWalk, tailFlip: shrimpWalk.tailFlip })),
    ).toThrow(/never swims .* cannot tail-flip/);
    expect(() =>
      toSimSpecies(withWalking(neriteSnail, { ...snailWalk, withdraw: undefined })),
    ).toThrow(/needs locomotion.walking.withdraw/);
    expect(() =>
      toSimSpecies(withWalking(neriteSnail, { ...snailWalk, withdraw: { minS: 9, maxS: 3 } })),
    ).toThrow(/withdraw.minS 9 exceeds maxS 3/);
    expect(() =>
      toSimSpecies(withWalking(cherryShrimp, { ...shrimpWalk, withdraw: { minS: 1, maxS: 2 } })),
    ).toThrow(/withdraw is for walkers that never swim/);
    expect(() =>
      toSimSpecies(withWalking(cherryShrimp, { ...shrimpWalk, tailFlip: undefined })),
    ).toThrow(/needs locomotion.walking.tailFlip/);
    expect(() =>
      toSimSpecies({
        ...neriteSnail,
        locomotion: { ...neriteSnail.locomotion, swimmingMode: 'carangiform' },
      }),
    ).toThrow(/needs swimmingMode "pleopod" or "none"/);
  });
});

describe('snails and hermit crabs in a running world', { timeout: LONG }, () => {
  it('stay on their surfaces and out of glass and rock for 10 000 steps', () => {
    const configs: [string, WorldConfig][] = [
      [
        'snails in the show tank',
        {
          seed: 11,
          tank: SHOW_TANK,
          species: SPECIES,
          decor: SHOW_DECOR,
          fish: spawnMany(neriteSnail.id, 8),
        },
      ],
      ['hermit crabs on the reef', reefConfig(spawnMany(hermitCrab.id, 8), 7)],
    ];
    for (const [label, config] of configs) {
      const w = new World(config);
      run(w, 60);
      let worst = Infinity;
      let attached = 0;
      let onSurface = 0;
      const steps = 10_000;
      for (let t = 0; t < steps; t++) {
        w.step();
        for (let i = 0; i < w.count; i++) {
          worst = Math.min(worst, w.bodyClearance(i));
          if (w.walkers.attached[i] !== 1) continue;
          attached++;
          const length = w.bodyLength[i] ?? 0;
          const d = distanceTo(w.substrateSdf, w, i);
          if (Math.abs(d - WALK.standoffBodyLengths * length) < 0.25 * length) onSurface++;
        }
      }
      expect(worst, label).toBeGreaterThanOrEqual(-1e-9);
      expect(attached, label).toBeGreaterThan(0.99 * steps * w.count);
      expect(onSurface / attached, label).toBeGreaterThan(0.999);
    }
  });

  it('graze the rock they are set on, not only the sand', () => {
    for (const s of SHELLED) {
      const w = showWorld([]);
      const [x, z] = [0.35, 0.05];
      w.addFish(
        { id: s.id, species: s.id },
        { position: [x, decorTop(w, x, z) + 0.01, z], heading: 0 },
      );
      w.setAlgae(1);
      const decor = w.decorSdf;
      if (decor === null) throw new Error('show tank lost its decor');
      let onRock = 0;
      const steps = 30 * 20;
      for (let t = 0; t < steps; t++) {
        w.step();
        const length = w.bodyLength[0] ?? 0;
        if (w.walkers.attached[0] === 1 && distanceTo(decor, w, 0) < 0.5 * length) onRock++;
      }
      expect(onRock, s.id).toBeGreaterThan(0.9 * steps);
      const tally = w.takeCrewTally();
      expect(
        tally.map((e) => e.fishId),
        s.id,
      ).toEqual([s.id]);
      expect(tally[0]?.algaeM2, s.id).toBeGreaterThan(0);
    }
  });

  it('graze at the rate the offline model gives the lifecycle', () => {
    for (const s of SHELLED) {
      const w = new World(reefConfig(spawnMany(s.id, 6), 3));
      w.setAlgae(1);
      const steps = 30 * 300;
      run(w, steps);
      const total = w.takeCrewTally().reduce((sum, e) => sum + e.algaeM2, 0);
      const perHour = total / 6 / ((steps * STEP_DT) / 3600);
      const offline = algaeAreaPerHour(sim(s));
      expect(perHour, s.id).toBeGreaterThan(0.5 * offline);
      expect(perHour, s.id).toBeLessThan(2 * offline);
    }
  });

  it('walk to settled food they smell beyond their sight and tally it as scavenged', () => {
    for (const s of SHELLED) {
      const w = new World({ seed: 3, tank: SHOW_TANK, species: SPECIES, fish: [] });
      const ground = w.basin.ground(0, 0);
      w.addFish(
        { id: s.id, species: s.id },
        { position: [0.1, ground + 0.01, 0], heading: Math.PI / 2 },
      );
      const rain = new FoodRain(SHOW_TANK);
      const off = 1.5 * sim(s).perceptionRange;
      rain.place('pellets', 0.1 - off, ground + 0.004, 0);
      // Time to walk there at the bout-averaged pace, with room to pick it clean.
      run(w, Math.ceil((4 * off) / sim(s).cruiseSpeed / STEP_DT) + 30 * 60, rain);
      expect(rain.eaten, s.id).toBeGreaterThan(0);
      const tally = w.takeCrewTally();
      expect(tally.find((e) => e.fishId === s.id)?.settledPortions, s.id).toBeCloseTo(
        rain.eaten,
        12,
      );
    }
  });

  it('withdraw into the shell where they stand when startled, then move on', () => {
    for (const s of SHELLED) {
      const w = showWorld(spawnMany(s.id, 1), 29);
      run(w, 90);
      expect(w.walkers.attached[0], s.id).toBe(1);
      let withdrew = false;
      for (let t = 0; t < 60 && !withdrew; t++) {
        w.startle({
          position: [(w.position[0] ?? 0) + 0.02, w.position[1] ?? 0, w.position[2] ?? 0],
          intensity: 1,
        });
        w.step();
        withdrew = w.state[0] === FishState.Shelter;
      }
      expect(withdrew, s.id).toBe(true);
      const at: [number, number, number] = [
        w.position[0] ?? 0,
        w.position[1] ?? 0,
        w.position[2] ?? 0,
      ];
      const w0 = sim(s).walking;
      if (w0 === null) throw new Error(`${s.id} lost its walking`);
      let hidden = 1;
      let drift = 0;
      while (w.state[0] === FishState.Shelter && hidden * STEP_DT < w0.withdrawMaxS + 1) {
        // Taps while it is shut in change nothing; one after it comes out would shut it again.
        if (hidden * STEP_DT < w0.withdrawMinS - 1) {
          w.startle({ position: [at[0] + 0.02, at[1], at[2]], intensity: 1 });
        }
        w.step();
        expect(w.walkers.attached[0], s.id).toBe(1);
        expect(w.walkers.flip[0], s.id).toBe(0);
        drift = Math.max(
          drift,
          Math.hypot(
            (w.position[0] ?? 0) - at[0],
            (w.position[1] ?? 0) - at[1],
            (w.position[2] ?? 0) - at[2],
          ),
        );
        if (w.state[0] === FishState.Shelter) hidden++;
      }
      expect(hidden * STEP_DT, s.id).toBeGreaterThanOrEqual(w0.withdrawMinS - STEP_DT);
      expect(hidden * STEP_DT, s.id).toBeLessThanOrEqual(w0.withdrawMaxS + STEP_DT);
      // Stopping from walking pace within the speed response, then not a step further.
      expect(drift, s.id).toBeLessThan(w0.walkSpeed * WALK.speedResponseS * 2);
      expect(w.state[0], s.id).not.toBe(FishState.Shelter);
      let path = 0;
      const after = 30;
      for (let t = 0; t < after / STEP_DT; t++) {
        const [x, y, z] = [w.position[0] ?? 0, w.position[1] ?? 0, w.position[2] ?? 0];
        w.step();
        path += Math.hypot(
          (w.position[0] ?? 0) - x,
          (w.position[1] ?? 0) - y,
          (w.position[2] ?? 0) - z,
        );
      }
      // Walking bouts take a third of the time between bouts of picking at the film.
      expect(path, s.id).toBeGreaterThan(0.1 * w0.walkSpeed * after);
    }
  });

  it('are deterministic', () => {
    const fish = [...spawnMany(neriteSnail.id, 4), ...spawnMany(hermitCrab.id, 4)].map((f, k) => ({
      ...f,
      id: `crew-${k}`,
    }));
    const a = new World(reefConfig(fish, 13));
    const b = new World(reefConfig(fish, 13));
    for (const w of [a, b]) w.setAlgae(0.5);
    for (let t = 0; t < 3000; t++) {
      if (t === 900) {
        a.startle({ position: [0, 0.05, 0], intensity: 1 });
        b.startle({ position: [0, 0.05, 0], intensity: 1 });
      }
      a.step();
      b.step();
    }
    expect(Array.from(a.position)).toEqual(Array.from(b.position));
    expect(a.takeCrewTally()).toEqual(b.takeCrewTally());
  });
});
