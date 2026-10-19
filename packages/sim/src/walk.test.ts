import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { speciesContentSchema } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import {
  cherryShrimp,
  neonTetra,
  REEF_ANCHORS,
  REEF_DECOR,
  REEF_TANK,
  SHOW_DECOR,
  SHOW_TANK,
  spawnMany,
  FoodRain,
} from './fixtures.ts';
import { FishState, SNAPSHOT_STRIDE, SnapshotField } from './snapshot.ts';
import { FLIP_PEAK_OVER_MEAN, toSimSpecies, type SpeciesInput } from './species.ts';
import { WALK } from './walk.ts';
import { STEP_DT, World, type WorldConfig } from './world.ts';

const LONG = 120_000;

const cherry = cherryShrimp;

function variant(
  id: string,
  edit: (w: NonNullable<SpeciesInput['locomotion']['walking']>) => void,
  traits: SpeciesInput['behaviour']['traits'] = cherry.behaviour.traits,
): SpeciesInput {
  const walking = structuredClone(cherry.locomotion.walking);
  if (walking === undefined) throw new Error('cherry fixture lost its walking block');
  edit(walking);
  return {
    ...cherry,
    id,
    behaviour: { ...cherry.behaviour, traits },
    locomotion: { ...cherry.locomotion, walking },
  };
}

function flipOf(w: NonNullable<SpeciesInput['locomotion']['walking']>) {
  if (w.tailFlip === undefined) throw new Error('walker fixture has no tail-flip');
  return w.tailFlip;
}

const floorOnly = variant('floor-shrimp', (w) => {
  w.surfaces = ['substrate', 'decor'];
});

function showConfig(seed: number, count: number, species = cherry): WorldConfig {
  return {
    seed,
    tank: SHOW_TANK,
    species: [species, neonTetra],
    decor: SHOW_DECOR,
    fish: spawnMany(species.id, count),
  };
}

/** Taps right beside walker `i` every step until it tail-flips; false if it never does. */
function startleUntilFlip(world: World, i: number, maxSteps: number): boolean {
  for (let t = 0; t < maxSteps; t++) {
    const o = i * 3;
    const x = world.position[o] ?? 0;
    world.startle({
      position: [x + 0.02, world.position[o + 1] ?? 0, world.position[o + 2] ?? 0],
      intensity: 1,
    });
    world.step();
    if (world.state[i] === FishState.TailFlip) return true;
  }
  return false;
}

function snapshot(world: World): Float32Array {
  const out = new Float32Array(world.count * SNAPSHOT_STRIDE);
  world.writeSnapshot(out);
  return out;
}

describe('walkers', { timeout: LONG }, () => {
  it('are deterministic', () => {
    const a = new World(showConfig(7, 8));
    const b = new World(showConfig(7, 8));
    for (let t = 0; t < 3000; t++) {
      if (t === 900) {
        a.startle({ position: [0, 0.05, 0], intensity: 1 });
        b.startle({ position: [0, 0.05, 0], intensity: 1 });
      }
      a.step();
      b.step();
    }
    expect(snapshot(a)).toEqual(snapshot(b));
    expect(new Float64Array(a.position)).toEqual(new Float64Array(b.position));
  });

  it('attach to a surface within a couple of seconds of spawning', () => {
    const world = new World(showConfig(3, 12));
    for (let t = 0; t < 60; t++) world.step();
    for (let i = 0; i < world.count; i++) expect(world.walkers.attached[i]).toBe(1);
  });

  it('never enter glass or rock, and stay on the surface they walk', () => {
    for (const config of [
      showConfig(11, 10),
      {
        seed: 5,
        tank: REEF_TANK,
        species: [cherry],
        decor: REEF_DECOR,
        anchors: REEF_ANCHORS,
        fish: spawnMany(cherry.id, 10),
      },
    ]) {
      const world = new World(config);
      let attachedTicks = 0;
      let onSurface = 0;
      let worst = Infinity;
      for (let t = 0; t < 10_000; t++) {
        world.step();
        for (let i = 0; i < world.count; i++) {
          const clearance = world.bodyClearance(i);
          worst = Math.min(worst, clearance);
          if (world.walkers.attached[i] !== 1) continue;
          attachedTicks++;
          const length = world.bodyLength[i] ?? 0;
          const o = i * 3;
          const d = world.substrateSdf.sample(
            world.position[o] ?? 0,
            world.position[o + 1] ?? 0,
            world.position[o + 2] ?? 0,
            new Float64Array(3),
          );
          if (Math.abs(d - WALK.standoffBodyLengths * length) < 0.25 * length) onSurface++;
        }
      }
      expect(worst).toBeGreaterThanOrEqual(-1e-9);
      expect(attachedTicks).toBeGreaterThan(0.95 * 10_000 * world.count);
      expect(onSurface / attachedTicks).toBeGreaterThan(0.999);
    }
  });

  it('carry an up axis along the surface normal and a heading in its plane', () => {
    const world = new World(showConfig(17, 10));
    const snap = new Float32Array(world.count * SNAPSHOT_STRIDE);
    for (let t = 0; t < 3000; t++) {
      world.step();
      if (t % 100 !== 0) continue;
      world.writeSnapshot(snap);
      for (let i = 0; i < world.count; i++) {
        const o = i * 3;
        const n = world.walkers.normal;
        const h = world.walkers.heading;
        const u = world.walkers.up;
        const dot = (a: Float64Array, b: Float64Array): number =>
          (a[o] ?? 0) * (b[o] ?? 0) +
          (a[o + 1] ?? 0) * (b[o + 1] ?? 0) +
          (a[o + 2] ?? 0) * (b[o + 2] ?? 0);
        expect(dot(h, h)).toBeCloseTo(1, 9);
        expect(dot(u, u)).toBeCloseTo(1, 9);
        expect(Math.abs(dot(h, u))).toBeLessThan(1e-9);
        if (world.walkers.attached[i] === 1) expect(Math.abs(dot(h, n))).toBeLessThan(1e-9);
        const s = i * SNAPSHOT_STRIDE;
        const leg = snap[s + SnapshotField.LegPhase] ?? -1;
        expect(leg).toBeGreaterThanOrEqual(0);
        expect(leg).toBeLessThan(1);
        expect(snap[s + SnapshotField.Attached]).toBe(world.walkers.attached[i]);
      }
    }
  });

  it('walk at no more than their walking speed, and move their legs as they go', () => {
    const world = new World(showConfig(23, 6));
    const start = world.walkers.legPhase.slice();
    let fastest = 0;
    let moved = 0;
    for (let t = 0; t < 1800; t++) {
      world.step();
      for (let i = 0; i < world.count; i++) {
        if (world.walkers.attached[i] === 1) fastest = Math.max(fastest, world.speed[i] ?? 0);
      }
    }
    for (let i = 0; i < world.count; i++) if (world.walkers.legPhase[i] !== start[i]) moved++;
    expect(fastest).toBeLessThanOrEqual(0.012 + 1e-12);
    expect(fastest).toBeGreaterThan(0.005);
    expect(moved).toBe(world.count);
  });

  it('tail-flip when startled, then ignore a second startle inside the refractory', () => {
    const world = new World(showConfig(29, 1));
    for (let t = 0; t < 90; t++) world.step();
    expect(world.walkers.attached[0]).toBe(1);
    const p = world.position;
    const start: [number, number, number] = [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
    expect(startleUntilFlip(world, 0, 30)).toBe(true);
    expect(world.walkers.attached[0]).toBe(0);
    const flips: number[] = [world.walkers.flip[0] ?? 0];
    let fastest = 0;
    for (;;) {
      fastest = Math.max(fastest, world.speed[0] ?? 0);
      world.step();
      if (world.state[0] !== FishState.TailFlip) break;
      flips.push(world.walkers.flip[0] ?? 0);
    }
    expect(flips.every((f, k) => k === 0 || f > (flips[k - 1] ?? 1))).toBe(true);
    expect(flips.at(-1)).toBe(1);
    expect(flips).toHaveLength(Math.ceil(0.15 / STEP_DT));
    expect(world.walkers.flip[0]).toBe(0);
    expect(fastest).toBeLessThanOrEqual(0.4);
    expect(fastest).toBeGreaterThan(0.25);
    const moved = Math.hypot(
      (p[0] ?? 0) - start[0],
      (p[1] ?? 0) - start[1],
      (p[2] ?? 0) - start[2],
    );
    // Mean speed over the pulse times its duration, give or take the glass in the way.
    expect(moved).toBeGreaterThan(0.5 * 0.25 * 0.15);

    // Taps on every step until the 2 s refractory has run out move it not at all.
    const flipTicks = flips.length + 1;
    for (let t = flipTicks; t < Math.floor(2 / STEP_DT) - 1; t++) {
      world.startle({ position: [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0], intensity: 1 });
      world.step();
      expect(world.state[0]).not.toBe(FishState.TailFlip);
      expect(world.walkers.flip[0]).toBe(0);
    }
    expect(startleUntilFlip(world, 0, 5 / STEP_DT)).toBe(true);
  });

  it('hold their refractory past the freeze that follows a flip', () => {
    const slow = variant('slow-recovery', (w) => {
      flipOf(w).refractoryS = 6;
    });
    const world = new World(showConfig(67, 1, slow));
    for (let t = 0; t < 90; t++) world.step();
    expect(startleUntilFlip(world, 0, 30)).toBe(true);
    for (let t = 0; t < 5.5 / STEP_DT; t++) {
      world.startle({ position: [world.position[0] ?? 0, 0, 0], intensity: 1 });
      world.step();
      if (t > 10) expect(world.state[0]).not.toBe(FishState.TailFlip);
    }
    expect(world.behaviour.isStartled(0)).toBe(false);
    expect(startleUntilFlip(world, 0, 3 / STEP_DT)).toBe(true);
  });

  // Each approach is its own world: from the open sand, and from behind the rock whose rounded
  // foot makes an undercut too low to walk into.
  it.each([-0.25, 0.3])('hide in their cave at night, starting %f m along the reef', (dx) => {
    const world = new World({
      seed: 71,
      tank: REEF_TANK,
      species: [cherry],
      decor: REEF_DECOR,
      anchors: REEF_ANCHORS,
      fish: [],
    });
    const [cx, , cz] = REEF_ANCHORS[1]?.position ?? [0, 0, 0];
    const i = world.addFish(
      { id: 'near-cave', species: cherry.id },
      { position: [cx + dx, 0.02, cz + 0.2], heading: 0 },
    );
    world.setLight(0);
    let sheltered = false;
    for (let t = 0; t < 180 / STEP_DT; t++) {
      world.step();
      if (world.state[i] === FishState.Shelter) sheltered = true;
    }
    expect(sheltered).toBe(true);
    const o = i * 3;
    expect(
      Math.hypot((world.position[o] ?? 0) - cx, (world.position[o + 2] ?? 0) - cz),
    ).toBeLessThan(0.1);
  });

  it('land again after a tail-flip and freeze before they walk on', () => {
    const world = new World(showConfig(31, 4));
    for (let t = 0; t < 90; t++) world.step();
    world.startle({ position: [0, 0.1, 0], intensity: 1 });
    world.step();
    const flipped = Array.from({ length: world.count }, (_, i) => i).filter(
      (i) => world.state[i] === FishState.TailFlip,
    );
    expect(flipped.length).toBeGreaterThan(0);
    for (let t = 0; t < 10 / STEP_DT; t++) world.step();
    for (const i of flipped) expect(world.walkers.attached[i]).toBe(1);
  });

  it('pick food off the sand', () => {
    const world = new World({ ...showConfig(37, 4), decor: [] });
    for (let t = 0; t < 60; t++) world.step();
    const rain = new FoodRain(SHOW_TANK);
    for (let i = 0; i < world.count; i++) {
      const o = i * 3;
      const x = (world.position[o] ?? 0) + 0.02 * Math.sin(world.yaw[i] ?? 0);
      const z = (world.position[o + 2] ?? 0) + 0.02 * Math.cos(world.yaw[i] ?? 0);
      rain.place('pellets', x, 0.003, z);
    }
    const eaters = new Set<string>();
    let picking = 0;
    for (let t = 0; t < 60 / STEP_DT && rain.count > 0; t++) {
      rain.feed(world);
      world.step();
      const events = world.takeAteEvents();
      rain.eat(events);
      for (const e of events) eaters.add(e.fishId);
      for (let i = 0; i < world.count; i++) if (world.state[i] === FishState.Pick) picking++;
    }
    expect(eaters.size).toBeGreaterThanOrEqual(3);
    expect(picking).toBeGreaterThan(0);
  });

  it('leave food that is not on a surface', () => {
    const world = new World({ ...showConfig(41, 4), decor: [] });
    for (let t = 0; t < 60; t++) world.step();
    const rain = new FoodRain(SHOW_TANK);
    for (let i = 0; i < world.count; i++) {
      const o = i * 3;
      rain.place('flakes', world.position[o] ?? 0, 0.1, 0, 1e9);
    }
    for (let t = 0; t < 300; t++) {
      rain.feed(world);
      world.step();
      expect(world.takeAteEvents()).toHaveLength(0);
      for (let i = 0; i < world.count; i++) expect(world.behaviour.feeding.target[i]).toBe(-1);
    }
  });

  it('keep off the glass when it is not one of their surfaces', () => {
    const world = new World(showConfig(43, 10, floorOnly));
    let worstUp = 1;
    for (let t = 0; t < 6000; t++) {
      world.step();
      for (let i = 0; i < world.count; i++) {
        if (world.walkers.attached[i] !== 1) continue;
        const o = i * 3;
        const x = world.position[o] ?? 0;
        const z = world.position[o + 2] ?? 0;
        const toGlass = Math.min(
          x - world.basin.minX,
          world.basin.maxX - x,
          z - world.basin.minZ,
          world.basin.maxZ - z,
        );
        // On rock the normal may tip anywhere; against the glass it may not stand up.
        if (toGlass < 0.3 * (world.bodyLength[i] ?? 0)) {
          worstUp = Math.min(worstUp, world.walkers.normal[o + 1] ?? 0);
        }
      }
    }
    expect(worstUp).toBeGreaterThan(0.6);
  });

  it('climb the glass when they may', () => {
    const world = new World({ ...showConfig(47, 10), decor: [] });
    let climbed = 0;
    for (let t = 0; t < 20_000; t++) {
      world.step();
      for (let i = 0; i < world.count; i++) {
        if (
          world.walkers.attached[i] === 1 &&
          Math.abs(world.walkers.normal[i * 3 + 1] ?? 1) < 0.2
        ) {
          climbed++;
        }
      }
    }
    expect(climbed).toBeGreaterThan(0);
  });

  it('leave existing swimmers alone in a mixed tank', () => {
    const config: WorldConfig = {
      seed: 53,
      tank: SHOW_TANK,
      species: [cherry, neonTetra],
      decor: SHOW_DECOR,
      fish: [...spawnMany('neon-tetra', 10), ...spawnMany(cherry.id, 4)],
    };
    const world = new World(config);
    for (let t = 0; t < 3000; t++) world.step();
    const snap = snapshot(world);
    for (let i = 0; i < 10; i++) {
      const s = i * SNAPSHOT_STRIDE;
      expect(snap[s + SnapshotField.LegPhase]).toBe(0);
      expect(snap[s + SnapshotField.Flip]).toBe(0);
      expect(snap[s + SnapshotField.Attached]).toBe(0);
      expect(world.bodyClearance(i)).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('can be added and removed while the world runs', () => {
    const world = new World(showConfig(59, 3));
    for (let t = 0; t < 30; t++) world.step();
    const i = world.addFish({ id: 'late', species: cherry.id });
    world.removeFish('cherry-shrimp-0');
    for (let t = 0; t < 120; t++) world.step();
    expect(world.walkers.attached[i - 1]).toBe(1);
    expect(world.walkers.legPhase).toHaveLength(world.count);
  });
});

describe('walker species', () => {
  const shipped = join(import.meta.dirname, '../../../content/species');

  it.each(['cherry-shrimp.json', 'cleaner-shrimp.json'])('loads and runs %s', (file) => {
    const raw: unknown = JSON.parse(readFileSync(join(shipped, file), 'utf8'));
    const species = speciesContentSchema.parse(raw);
    const sim = toSimSpecies(species);
    expect(sim.walking).not.toBeNull();
    const world = new World({
      seed: 61,
      tank: REEF_TANK,
      species: [species],
      decor: REEF_DECOR,
      anchors: REEF_ANCHORS,
      fish: spawnMany(species.id, 4),
    });
    for (let t = 0; t < 600; t++) world.step();
    for (let i = 0; i < world.count; i++) {
      expect(world.bodyClearance(i)).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('rejects a walk faster than the cruise speed', () => {
    expect(() =>
      toSimSpecies(
        variant('fast', (w) => {
          w.walkSpeedMps = 0.06;
        }),
      ),
    ).toThrow(/walkSpeedMps 0.06 exceeds cruiseSpeedMps 0.05/);
  });

  it('rejects a tail-flip whose peak would beat the maximum speed', () => {
    const limit = 0.4 / FLIP_PEAK_OVER_MEAN;
    expect(() =>
      toSimSpecies(
        variant('flip', (w) => {
          flipOf(w).speedMps = limit * 1.01;
        }),
      ),
    ).toThrow(/tail-flip peak .* exceeds maxSpeedMps 0.4/);
    expect(
      toSimSpecies(
        variant('flip', (w) => {
          flipOf(w).speedMps = limit;
        }),
      ).walking?.flipPeak,
    ).toBeCloseTo(0.4, 12);
  });

  it('rejects swimmer traits on a walker and walker traits on a swimmer', () => {
    expect(() => toSimSpecies(variant('shoaler', () => undefined, ['shoal']))).toThrow(
      /trait "shoal" is for swimmers/,
    );
    expect(() =>
      toSimSpecies({
        ...neonTetra,
        behaviour: { ...neonTetra.behaviour, traits: ['biofilm-grazer'] },
      }),
    ).toThrow(/trait "biofilm-grazer" needs locomotion.walking/);
  });

  it('rejects a walker that schools or holds territory', () => {
    expect(() =>
      toSimSpecies({
        ...cherry,
        behaviour: {
          ...cherry.behaviour,
          schooling: { minGroup: 6, topologicalNeighbours: 6, tightenWhenStartled: false },
        },
      }),
    ).toThrow(/walkers do not school/);
    expect(() =>
      toSimSpecies({ ...cherry, behaviour: { ...cherry.behaviour, territorial: true } }),
    ).toThrow(/walkers hold no territory/);
  });
});
