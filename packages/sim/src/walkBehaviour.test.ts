import type { Collider, SphereCollider } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { BEHAVIOUR } from './behaviour.ts';
import {
  blueTang,
  cherryShrimp,
  FoodRain,
  neonTetra,
  REEF_ANCHORS,
  REEF_DECOR,
  REEF_TANK,
  SHOW_DECOR,
  SHOW_TANK,
  spawnMany,
} from './fixtures.ts';
import { FishState } from './snapshot.ts';
import type { SpeciesInput } from './species.ts';
import { STEP_DT, World, type WorldConfig } from './world.ts';

const LONG = 240_000;
const CAVE = 1;
const cave = REEF_ANCHORS[CAVE];
if (cave === undefined) throw new Error('reef fixture lost its cave');
const [caveX, , caveZ] = cave.position;
const caveRadius = cave.radius;

function sized(id: string, bodyLengthM: number, traits = cherryShrimp.behaviour.traits) {
  return {
    ...cherryShrimp,
    id,
    behaviour: { ...cherryShrimp.behaviour, traits },
    locomotion: { ...cherryShrimp.locomotion, bodyLengthM },
  } satisfies SpeciesInput;
}

function caveRoom(bodyLengthM: number): number {
  return Math.max(1, Math.floor(BEHAVIOUR.walkerCaveShare * (caveRadius / bodyLengthM) ** 2));
}

/** A reef tank with `count` walkers of `species` on the sand in front of the cave. */
function reefNearCave(seed: number, species: SpeciesInput, count: number, anchors = REEF_ANCHORS) {
  const world = new World({
    seed,
    tank: REEF_TANK,
    species: [species],
    decor: REEF_DECOR,
    anchors,
    fish: [],
  });
  for (let k = 0; k < count; k++) {
    world.addFish(
      { id: `${species.id}-${k}`, species: species.id },
      { position: [caveX - 0.2 + (0.4 * k) / count, 0.02, caveZ + 0.22], heading: k },
    );
  }
  return world;
}

function run(world: World, seconds: number, each?: (t: number) => void): void {
  for (let t = 0; t < seconds / STEP_DT; t++) {
    world.step();
    each?.(t);
  }
}

function planDistance(world: World, i: number, x: number, z: number): number {
  return Math.hypot((world.position[i * 3] ?? 0) - x, (world.position[i * 3 + 2] ?? 0) - z);
}

function decorDistance(world: World, i: number): number {
  const sdf = world.decorSdf;
  if (sdf === null) throw new Error('world has no hard decor');
  const o = i * 3;
  return sdf.sample(
    world.position[o] ?? 0,
    world.position[o + 1] ?? 0,
    world.position[o + 2] ?? 0,
    new Float64Array(3),
  );
}

function worstClearance(world: World): number {
  let worst = Infinity;
  for (let i = 0; i < world.count; i++) worst = Math.min(worst, world.bodyClearance(i));
  return worst;
}

/** Lengths in seconds of the runs of `state` in each track, leaving out runs cut by either end. */
function boutLengths(tracks: readonly number[][], state: FishState): number[] {
  const bouts: number[] = [];
  for (const track of tracks) {
    let start = -1;
    track.forEach((s, t) => {
      if (s === state && start < 0) start = t;
      if (s !== state && start >= 0) {
        if (start > 0) bouts.push((t - start) * STEP_DT);
        start = -1;
      }
    });
  }
  return bouts;
}

describe('cave-dwelling walkers at night', { timeout: LONG }, () => {
  it('share a cave up to its room and shelter the rest against its rock', () => {
    const room = caveRoom(cherryShrimp.locomotion.bodyLengthM);
    expect(room).toBeGreaterThan(1);
    const world = reefNearCave(3, cherryShrimp, room + 2);
    world.setLight(0);
    let worst = Infinity;
    run(world, 180, () => {
      worst = Math.min(worst, worstClearance(world));
    });
    const length = cherryShrimp.locomotion.bodyLengthM;
    const holders = [];
    const overflow = [];
    for (let i = 0; i < world.count; i++) {
      expect(world.state[i]).toBe(FishState.Shelter);
      if (world.behaviour.anchor[i] === CAVE) holders.push(i);
      else overflow.push(i);
    }
    expect(holders).toHaveLength(room);
    expect(overflow).toHaveLength(2);
    for (const i of holders) {
      expect(planDistance(world, i, caveX, caveZ)).toBeLessThanOrEqual(cave.radius + 0.5 * length);
    }
    for (const i of overflow) {
      expect(world.behaviour.anchor[i]).toBe(-1);
      expect(decorDistance(world, i)).toBeLessThan(BEHAVIOUR.walkerNookDecorBodyLengths * length);
    }
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
  });

  it('take a cave alone when they are too big to share it', () => {
    const big = sized('big-shrimp', 0.06);
    expect(caveRoom(0.06)).toBe(1);
    const world = reefNearCave(5, big, 2);
    world.setLight(0);
    run(world, 180);
    expect(world.behaviour.anchor.filter((a) => a === CAVE)).toHaveLength(1);
    for (let i = 0; i < world.count; i++) expect(world.state[i]).toBe(FishState.Shelter);
  });

  it('rest in the open, still moving, when the tank has no cave', () => {
    const world = reefNearCave(7, cherryShrimp, 3, []);
    run(world, 2);
    world.setLight(0);
    run(world, 20);
    const at = Array.from(world.position);
    let resting = 0;
    run(world, 20, () => {
      for (let i = 0; i < world.count; i++) if (world.state[i] === FishState.Rest) resting++;
    });
    expect(resting).toBeGreaterThan(0.9 * world.count * (20 / STEP_DT));
    for (let i = 0; i < world.count; i++) {
      expect(world.behaviour.anchor[i]).toBe(-1);
      expect(planDistance(world, i, at[i * 3] ?? 0, at[i * 3 + 2] ?? 0)).toBeGreaterThan(0);
    }
  });

  it('move into a place a removed cave-mate left, the next night', () => {
    const room = caveRoom(cherryShrimp.locomotion.bodyLengthM);
    const world = reefNearCave(11, cherryShrimp, room + 1);
    world.setLight(0);
    run(world, 120);
    const outside = Array.from(world.behaviour.anchor).indexOf(-1);
    expect(outside).toBeGreaterThanOrEqual(0);
    const insideId = world.fishIds[Array.from(world.behaviour.anchor).indexOf(CAVE)];
    if (insideId === undefined) throw new Error('nobody holds the cave');
    const outsideId = world.fishIds[outside];
    world.setLight(1);
    run(world, 30);
    world.removeFish(insideId);
    const i = world.fishIds.indexOf(outsideId ?? '');
    world.setLight(0);
    run(world, 180);
    expect(world.behaviour.anchor[i]).toBe(CAVE);
    expect(world.state[i]).toBe(FishState.Shelter);
    expect(planDistance(world, i, caveX, caveZ)).toBeLessThanOrEqual(
      cave.radius + 0.5 * cherryShrimp.locomotion.bodyLengthM,
    );
  });

  it('spread a crowd turned away from a full cave over separate nooks', () => {
    const room = caveRoom(cherryShrimp.locomotion.bodyLengthM);
    const world = reefNearCave(3, cherryShrimp, room + 5);
    world.setLight(0);
    run(world, 240);
    const length = cherryShrimp.locomotion.bodyLengthM;
    const overflow = [];
    for (let i = 0; i < world.count; i++) {
      expect(world.state[i]).toBe(FishState.Shelter);
      if (world.behaviour.anchor[i] !== CAVE) overflow.push(i);
    }
    expect(overflow).toHaveLength(5);
    for (const i of overflow) {
      for (const j of overflow) {
        if (j <= i) continue;
        const o = j * 3;
        const apart = planDistance(world, i, world.position[o] ?? 0, world.position[o + 2] ?? 0);
        expect(apart).toBeGreaterThan(0.5 * length);
      }
    }
  });

  it('shelter in a nook outside a cave they cannot get into', () => {
    const [x0, z0] = [0.5, 0];
    const length = cherryShrimp.locomotion.bodyLengthM;
    const wall = (id: string, dx: number, dz: number, hx: number, hz: number): Collider => ({
      id,
      hard: true,
      kind: 'box',
      center: [x0 + dx, REEF_TANK.height / 2, z0 + dz],
      halfExtents: [hx, REEF_TANK.height / 2, hz],
      rotationY: 0,
      rounding: 0,
    });
    const world = new World({
      seed: 9,
      tank: REEF_TANK,
      species: [cherryShrimp],
      decor: [
        wall('n', 0, 0.05, 0.06, 0.01),
        wall('s', 0, -0.05, 0.06, 0.01),
        wall('e', 0.05, 0, 0.01, 0.06),
        wall('w', -0.05, 0, 0.01, 0.06),
      ],
      anchors: [{ id: 'walled-in', kind: 'cave', position: [x0, 0.03, z0], radius: 0.03 }],
      fish: [],
    });
    world.addFish(
      { id: 'shut-out', species: cherryShrimp.id },
      { position: [0.2, 0.02, 0], heading: 1 },
    );
    world.setLight(0);
    run(world, BEHAVIOUR.walkerCaveGiveUpS + 60);
    expect(world.behaviour.anchor[0]).toBe(-1);
    let sheltering = 0;
    const seconds = 60;
    run(world, seconds, () => {
      if (world.state[0] === FishState.Shelter) sheltering++;
    });
    expect(sheltering).toBeGreaterThan(0.9 * (seconds / STEP_DT));
    const fromCave = planDistance(world, 0, x0, z0);
    expect(fromCave).toBeGreaterThan(0.06);
    expect(fromCave).toBeLessThan(0.06 + 2 * length);
  });

  it('rest where they are when neither the cave nor a nook beside it can be reached', () => {
    const [x0, z0] = [0.5, 0];
    const wall = (id: string, dx: number, dz: number, hx: number, hz: number): Collider => ({
      id,
      hard: true,
      kind: 'box',
      center: [x0 + dx, REEF_TANK.height / 2, z0 + dz],
      halfExtents: [hx, REEF_TANK.height / 2, hz],
      rotationY: 0,
      rounding: 0,
    });
    const world = new World({
      seed: 9,
      tank: REEF_TANK,
      species: [cherryShrimp],
      decor: [
        wall('n', 0, 0.1, 0.11, 0.01),
        wall('s', 0, -0.1, 0.11, 0.01),
        wall('e', 0.1, 0, 0.01, 0.11),
        wall('w', -0.1, 0, 0.01, 0.11),
      ],
      anchors: [{ id: 'walled-in', kind: 'cave', position: [x0, 0.03, z0], radius: 0.03 }],
      fish: [],
    });
    world.addFish(
      { id: 'shut-out', species: cherryShrimp.id },
      { position: [0.2, 0.02, 0], heading: 1 },
    );
    world.setLight(0);
    run(world, 40);
    expect(world.behaviour.anchor[0]).toBe(0);
    run(world, BEHAVIOUR.walkerCaveGiveUpS + BEHAVIOUR.walkerNookGiveUpS + 60);
    expect(world.behaviour.anchor[0]).toBe(-1);
    let resting = 0;
    const seconds = 60;
    run(world, seconds, () => {
      if (world.state[0] === FishState.Rest) resting++;
    });
    expect(resting).toBeGreaterThan(0.9 * (seconds / STEP_DT));
  });

  it('head for the nearest cave with room, not the first', () => {
    const world = new World({
      seed: 5,
      tank: REEF_TANK,
      species: [cherryShrimp],
      decor: [],
      anchors: [
        { id: 'far', kind: 'cave', position: [-0.6, 0.03, 0], radius: 0.05 },
        { id: 'near', kind: 'cave', position: [0.4, 0.03, 0], radius: 0.05 },
      ],
      fish: [],
    });
    world.addFish(
      { id: 'shrimp', species: cherryShrimp.id },
      { position: [0.2, 0.02, 0], heading: 0 },
    );
    world.setLight(0);
    run(world, 60);
    expect(world.behaviour.anchor[0]).toBe(1);
  });

  it('leave resting swimmers on their stations when the anchors change', () => {
    const config: WorldConfig = {
      seed: 17,
      tank: REEF_TANK,
      species: [blueTang, cherryShrimp],
      decor: REEF_DECOR,
      anchors: REEF_ANCHORS,
      fish: spawnMany(blueTang.id, 3),
    };
    const [same, remounted] = [new World(config), new World(config)];
    for (const w of [same, remounted]) {
      w.setLight(0);
      run(w, 60);
    }
    remounted.setAnchors(REEF_ANCHORS);
    run(same, 30);
    run(remounted, 30);
    expect(new Float64Array(remounted.position)).toEqual(new Float64Array(same.position));
  });

  it('share caves deterministically', () => {
    const a = reefNearCave(13, cherryShrimp, 8);
    const b = reefNearCave(13, cherryShrimp, 8);
    a.setLight(0);
    b.setLight(0);
    run(a, 60);
    run(b, 60);
    expect(new Float64Array(a.position)).toEqual(new Float64Array(b.position));
    expect(Array.from(a.behaviour.anchor)).toEqual(Array.from(b.behaviour.anchor));
  });
});

describe('walker foraging and escape', { timeout: LONG }, () => {
  it.each([
    ['grazer', cherryShrimp, BEHAVIOUR.grazerPickMinS, BEHAVIOUR.grazerPickMaxS],
    [
      'non-grazer',
      sized('scavenger-shrimp', 0.03, ['cave-dweller']),
      BEHAVIOUR.walkerPickMinS,
      BEHAVIOUR.walkerPickMaxS,
    ],
  ] as const)('alternate pick and walk bouts as a %s', (_, species, min, max) => {
    const world = new World({
      seed: 17,
      tank: SHOW_TANK,
      species: [species],
      decor: [],
      fish: spawnMany(species.id, 6),
    });
    const tracks: number[][] = Array.from({ length: world.count }, () => []);
    run(world, 300, () => {
      for (let i = 0; i < world.count; i++) tracks[i]?.push(world.state[i] ?? -1);
    });
    const picks = boutLengths(tracks, FishState.Pick);
    const walks = boutLengths(tracks, FishState.Walk);
    expect(picks.length).toBeGreaterThan(20);
    expect(walks.length).toBeGreaterThan(20);
    for (const b of picks) expect(b).toBeLessThanOrEqual(max + 2 * STEP_DT);
    const mean = picks.reduce((s, b) => s + b, 0) / picks.length;
    expect(mean).toBeGreaterThan(min);
    expect(mean).toBeLessThan(max);
  });

  it('climb a rock to food lying on top of it', () => {
    const stone: SphereCollider = {
      id: 'pebble',
      hard: true,
      kind: 'sphere',
      center: [0.35, 0, 0.05],
      radius: 0.06,
    };
    const world = new World({
      seed: 19,
      tank: SHOW_TANK,
      species: [cherryShrimp],
      decor: [stone],
      fish: [],
    });
    const [sx, , sz] = stone.center;
    // Close enough for the food on top to lie inside its 15 cm perception range.
    world.addFish(
      { id: 'climber', species: cherryShrimp.id },
      { position: [sx - stone.radius - 0.02, 0.02, sz], heading: Math.PI / 2 },
    );
    run(world, 2);
    const rain = new FoodRain(SHOW_TANK);
    rain.place('pellets', sx, stone.center[1] + stone.radius + 0.002, sz, 1e9);
    let ate = false;
    let worst = Infinity;
    for (let t = 0; t < 120 / STEP_DT && !ate; t++) {
      rain.feed(world);
      world.step();
      worst = Math.min(worst, worstClearance(world));
      ate = world.takeAteEvents().length > 0;
    }
    expect(ate).toBe(true);
    expect(world.position[1]).toBeGreaterThan(stone.center[1] + 0.5 * stone.radius);
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
  });

  it('flee to their cave after a tail-flip by day', () => {
    const world = new World({
      seed: 23,
      tank: REEF_TANK,
      species: [cherryShrimp],
      decor: REEF_DECOR,
      anchors: REEF_ANCHORS,
      fish: [],
    });
    world.addFish(
      { id: 'near-cave', species: cherryShrimp.id },
      { position: [caveX - 0.03, 0.02, caveZ + 0.12], heading: 0 },
    );
    run(world, 3);
    let flipped = false;
    for (let t = 0; t < 30 && !flipped; t++) {
      world.startle({
        position: [(world.position[0] ?? 0) + 0.02, world.position[1] ?? 0, world.position[2] ?? 0],
        intensity: 1,
      });
      world.step();
      flipped = world.state[0] === FishState.TailFlip;
    }
    expect(flipped).toBe(true);
    let sheltered = false;
    run(world, BEHAVIOUR.shelterAfterStartleS, () => {
      sheltered ||=
        world.state[0] === FishState.Shelter && planDistance(world, 0, caveX, caveZ) < 0.1;
    });
    expect(sheltered).toBe(true);
  });

  it('are set down on the sand when added in open water', () => {
    const world = new World({
      seed: 29,
      tank: SHOW_TANK,
      species: [cherryShrimp],
      decor: SHOW_DECOR,
      fish: [],
    });
    const i = world.addFish(
      { id: 'dropped', species: cherryShrimp.id },
      { position: [0, 0.3, 0.1], heading: 0 },
    );
    world.step();
    expect(world.walkers.attached[i]).toBe(1);
    expect(world.position[i * 3 + 1]).toBeLessThan(0.05);
    let worst = Infinity;
    run(world, 15, () => {
      worst = Math.min(worst, world.bodyClearance(i));
    });
    expect(world.walkers.attached[i]).toBe(1);
    expect(world.position[i * 3 + 1]).toBeLessThan(0.05);
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
  });
});

describe('walkers on moving and unusual decor', { timeout: LONG }, () => {
  const hull: Collider = {
    id: 'slab',
    hard: true,
    kind: 'hull',
    vertices: [
      [-0.12, 0, -0.08],
      [0.14, 0, -0.1],
      [0.1, 0, 0.12],
      [-0.1, 0, 0.1],
      [-0.04, 0.09, 0],
      [0.05, 0.07, 0.02],
    ],
  };

  it('fall to the sand when the rock they stand on is taken away, and stay out of one moved onto them', () => {
    const stone = SHOW_DECOR.find((c) => c.id === 'stone');
    if (stone?.kind !== 'sphere') throw new Error('show fixture lost its stone');
    const world = new World({
      seed: 31,
      tank: SHOW_TANK,
      species: [cherryShrimp],
      decor: [stone],
      fish: [],
    });
    const [sx, sy, sz] = stone.center;
    const i = world.addFish(
      { id: 'percher', species: cherryShrimp.id },
      { position: [sx, sy + stone.radius + 0.01, sz], heading: 0 },
    );
    run(world, 1);
    expect(world.walkers.attached[i]).toBe(1);
    expect(world.position[i * 3 + 1]).toBeGreaterThan(sy + 0.8 * stone.radius);
    world.setDecor([]);
    let fell = false;
    run(world, 10, () => {
      fell ||= world.state[i] === FishState.Fall;
    });
    expect(fell).toBe(true);
    expect(world.walkers.attached[i]).toBe(1);
    expect(world.position[i * 3 + 1]).toBeLessThan(0.02);

    const o = i * 3;
    world.setDecor([
      { ...stone, center: [world.position[o] ?? 0, 0, world.position[o + 2] ?? 0], radius: 0.06 },
    ]);
    let worst = Infinity;
    run(world, 10, () => {
      worst = Math.min(worst, world.bodyClearance(i));
    });
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
    expect(world.walkers.attached[i]).toBe(1);
  });

  it('walk over a hull rock without entering it', () => {
    const world = new World({
      seed: 37,
      tank: SHOW_TANK,
      species: [cherryShrimp],
      decor: [hull],
      fish: spawnMany(cherryShrimp.id, 8),
    });
    let onRock = 0;
    let worst = Infinity;
    run(world, 300, () => {
      worst = Math.min(worst, worstClearance(world));
      for (let i = 0; i < world.count; i++) {
        if (world.walkers.attached[i] === 1 && (world.position[i * 3 + 1] ?? 0) > 0.03) onRock++;
      }
    });
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
    expect(onRock).toBeGreaterThan(0);
  });

  it('keep a unit heading in the surface plane over the edges of a box', () => {
    const block: Collider = {
      id: 'block',
      hard: true,
      kind: 'box',
      center: [0, 0.04, 0],
      halfExtents: [0.08, 0.04, 0.06],
      rotationY: 0.4,
      rounding: 0,
    };
    const world = new World({
      seed: 41,
      tank: SHOW_TANK,
      species: [cherryShrimp],
      decor: [block],
      fish: spawnMany(cherryShrimp.id, 8),
    });
    let worstLength = 0;
    let worstDot = 0;
    let onTop = 0;
    run(world, 300, () => {
      for (let i = 0; i < world.count; i++) {
        if (world.walkers.attached[i] !== 1) continue;
        const o = i * 3;
        const h = [0, 1, 2].map((c) => world.walkers.heading[o + c] ?? 0);
        const n = [0, 1, 2].map((c) => world.walkers.normal[o + c] ?? 0);
        worstLength = Math.max(worstLength, Math.abs(Math.hypot(...h) - 1));
        worstDot = Math.max(worstDot, Math.abs(h.reduce((s, v, c) => s + v * (n[c] ?? 0), 0)));
        if ((world.position[o + 1] ?? 0) > 0.08) onTop++;
      }
    });
    expect(worstLength).toBeLessThan(1e-6);
    expect(worstDot).toBeLessThan(1e-6);
    expect(onTop).toBeGreaterThan(0);
    expect(worstClearance(world)).toBeGreaterThanOrEqual(-1e-9);
  });
});

describe('swimmers sharing a tank with walkers', { timeout: LONG }, () => {
  function neonStats(withShrimp: boolean) {
    const config: WorldConfig = {
      seed: 43,
      tank: SHOW_TANK,
      species: [neonTetra, cherryShrimp],
      decor: SHOW_DECOR,
      fish: [...spawnMany(neonTetra.id, 12), ...(withShrimp ? spawnMany(cherryShrimp.id, 12) : [])],
    };
    const world = new World(config);
    const neons = 12;
    let speed = 0;
    let polar = 0;
    let samples = 0;
    let worst = Infinity;
    let overlap = 0;
    run(world, 120, (t) => {
      for (let i = 0; i < neons; i++) worst = Math.min(worst, world.bodyClearance(i));
      if (withShrimp) {
        for (let i = 0; i < neons; i++) {
          for (let j = neons; j < world.count; j++) {
            const touch = 0.12 * ((world.bodyLength[i] ?? 0) + (world.bodyLength[j] ?? 0)) * 0.5;
            if (
              planDistance(world, i, world.position[j * 3] ?? 0, world.position[j * 3 + 2] ?? 0) <
                touch &&
              Math.abs((world.position[i * 3 + 1] ?? 0) - (world.position[j * 3 + 1] ?? 0)) < touch
            ) {
              overlap++;
            }
          }
        }
      }
      if (t < 300) return;
      let fx = 0;
      let fy = 0;
      let fz = 0;
      for (let i = 0; i < neons; i++) {
        speed += world.speed[i] ?? 0;
        fx += world.forward[i * 3] ?? 0;
        fy += world.forward[i * 3 + 1] ?? 0;
        fz += world.forward[i * 3 + 2] ?? 0;
      }
      polar += Math.hypot(fx, fy, fz) / neons;
      samples++;
    });
    return { speed: speed / (samples * neons), polar: polar / samples, worst, overlap };
  }

  it('swim as they do without them, and never pass through them', () => {
    const alone = neonStats(false);
    const mixed = neonStats(true);
    expect(mixed.worst).toBeGreaterThanOrEqual(-1e-9);
    expect(mixed.overlap).toBe(0);
    expect(mixed.speed).toBeGreaterThan(0.75 * alone.speed);
    expect(mixed.speed).toBeLessThan(1.25 * alone.speed);
    expect(Math.abs(mixed.polar - alone.polar)).toBeLessThan(0.15);
  });
});
