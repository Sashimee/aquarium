import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createTankSpace,
  speciesContentSchema,
  TANK_SIZES,
  tankWaterBounds,
  type Collider,
} from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { Basin } from './basin.ts';
import { DecorField, UnionSdf } from './decor.ts';
import { royalGramma, spawnMany } from './fixtures.ts';
import { findNooks, NookSearch } from './nooks.ts';
import { Rng } from './rng.ts';
import { FishState } from './snapshot.ts';
import { TankSdf } from './sdf.ts';
import { toSimSpecies, type SpeciesInput } from './species.ts';
import { bodyTurnRoom, World, maxFishLengthM, type FishSpawn } from './world.ts';

const LONG = 120_000;

/** A nano-sized box of water, 40 cm wide, 25 cm high and 30 cm deep, with no sand. */
const NANO = { width: 0.4, height: 0.25, depth: 0.3 } as const;

/** A nano reef's rockwork: a wall of live rock along the back with a ledge over the sand. */
const NANO_ROCK: readonly Collider[] = [
  {
    id: 'back-rock',
    hard: true,
    kind: 'box',
    center: [0, 0.07, -0.12],
    halfExtents: [0.18, 0.07, 0.03],
    rotationY: 0,
    rounding: 0.01,
  },
  {
    id: 'ledge',
    hard: true,
    kind: 'box',
    center: [0.08, 0.15, -0.09],
    halfExtents: [0.1, 0.015, 0.03],
    rotationY: 0,
    rounding: 0.005,
  },
  { id: 'boulder', hard: true, kind: 'sphere', center: [-0.14, 0, 0.09], radius: 0.05 },
];

const dir = join(import.meta.dirname, '../../../content/species');
const roster = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => speciesContentSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
const pleco = roster.find((s) => s.id === 'bristlenose-pleco');
if (pleco === undefined) throw new Error('no content/species/bristlenose-pleco.json');
const firefish = roster.find((s) => s.id === 'firefish');
if (firefish === undefined) throw new Error('no content/species/firefish.json');

function rockField(decor: readonly Collider[]): DecorField {
  const field = new DecorField(NANO, 0.3);
  field.set(decor);
  return field;
}

function nano(
  fish: FishSpawn[],
  seed: number,
  decor = NANO_ROCK,
  species: readonly SpeciesInput[] = [royalGramma],
): World {
  return new World({ seed, tank: NANO, species, decor, fish });
}

function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range`);
  return v;
}

describe('the longest fish a tank holds', () => {
  it('is set by the shortest of the tank’s width, water height and depth', () => {
    expect(maxFishLengthM(NANO)).toBeCloseTo(0.25, 12);
    expect(maxFishLengthM({ width: 1.2, height: 0.5, depth: 0.4 })).toBeCloseTo(0.4, 12);
  });

  it('counts only the water over the highest sand in a nano30 with a sand slope', () => {
    const { length, depth, height, glass, freeboard } = TANK_SIZES.nano30.dimensions;
    // Sand banked from 2 cm at the front pane to 5 cm at the back.
    const space = createTankSpace(
      { width: length, depth, height, glass, freeboard },
      (_x, z) => 0.035 - 0.015 * (z / (depth / 2)),
    );
    const water = tankWaterBounds(space);
    const overSand = water.max[1] - space.floor.max;
    expect(overSand).toBeLessThan(water.max[2] - water.min[2]);
    expect(maxFishLengthM(space)).toBeCloseTo(overSand, 12);
    const spawn = (bodyLengthM: number) =>
      new World({
        seed: 1,
        space,
        species: [royalGramma],
        fish: [{ id: 'a', species: royalGramma.id, bodyLengthM }],
      });
    expect(spawn(overSand * 0.99).count).toBe(1);
    expect(() => spawn(overSand)).toThrow(/does not fit in the tank/);
  });

  it('spawns a fish just under it and turns one at it away with the limit in the message', () => {
    const longest = maxFishLengthM(NANO);
    const spawn = (bodyLengthM: number) =>
      new World({
        seed: 1,
        tank: NANO,
        species: [royalGramma],
        fish: [{ id: 'a', species: royalGramma.id, bodyLengthM }],
      });
    expect(spawn(longest * 0.99).count).toBe(1);
    expect(() => spawn(longest)).toThrow(
      /does not fit in the tank, which holds fish shorter than 0\.250 m/,
    );
  });
});

describe('spawning a big fish among nano rockwork', () => {
  // Every random draw needs two radii of clear water from hard decor; none exists here.
  const length = 0.15;
  const r = 0.5 * length;
  const fish = [{ id: 'big', species: royalGramma.id, bodyLengthM: length }];

  it('has no spot two radii clear of the rock, so the random draws all fail', () => {
    // A draw keeps two radii off the glass, which in 30 cm of depth leaves only the midline.
    const pad = 2 * r;
    const rock = rockField(NANO_ROCK);
    const n = new Float64Array(3);
    let roomiest = -Infinity;
    for (let x = -0.2 + pad; x <= 0.2 - pad; x += 0.005) {
      for (let y = 0; y <= 0.25; y += 0.005) {
        roomiest = Math.max(roomiest, rock.sample(x, y, 0, n));
      }
    }
    expect(roomiest).toBeLessThan(2 * r);
  });

  it('starts it in the roomiest water, clear of everything and the same every time', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const w = nano(fish, seed);
      const p = Array.from(w.position);
      expect(p.every(Number.isFinite), `seed ${seed}`).toBe(true);
      expect(w.bodyClearance(0), `seed ${seed}`).toBeGreaterThan(0);
      expect(Array.from(nano(fish, seed).position)).toEqual(p);
      for (let t = 0; t < 900; t++) w.step();
      expect(w.bodyClearance(0), `seed ${seed}`).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('fails with a clear message when the rock leaves no room for the body anywhere', () => {
    const filled: Collider[] = [
      {
        id: 'fill',
        hard: true,
        kind: 'box',
        center: [0, 0.1, 0],
        halfExtents: [0.2, 0.1, 0.15],
        rotationY: 0,
        rounding: 0,
      },
    ];
    expect(() => nano(fish, 1, filled)).toThrow(
      /"big": no free water to spawn in, decor fills the tank/,
    );
  });
});

describe('every species that fits a nano', { timeout: LONG }, () => {
  const longest = maxFishLengthM(NANO);
  const cases = roster.flatMap((s) =>
    [s.locomotion.bodyLengthM, s.lifecycle.maxSizeM]
      .filter((length) => length < longest)
      .map((length) => ({ id: s.id, s, length })),
  );

  it.each(cases)(
    '$id at $length m starts among the rock and stays clear of it',
    ({ s, length }) => {
      for (const seed of [1, 2, 3]) {
        const w = nano([{ id: 'a', species: s.id, bodyLengthM: length }], seed, NANO_ROCK, [s]);
        for (let t = 0; t < 600; t++) {
          w.step();
          expect(w.bodyClearance(0), `seed ${seed}, step ${t}`).toBeGreaterThanOrEqual(-1e-9);
        }
      }
    },
  );
});

describe('crevices for cave-dwellers when the scene has no cave', { timeout: LONG }, () => {
  const length = toSimSpecies(royalGramma).bodyLength;
  const field = () => {
    const basin = Basin.fromTank(NANO);
    const rock = rockField(NANO_ROCK);
    return {
      basin,
      rock,
      cover: new UnionSdf([new TankSdf(basin, { surface: false }), rock]),
      water: new UnionSdf([new TankSdf(basin), rock]),
    };
  };

  const room = bodyTurnRoom(length);

  it('finds them deterministically, each with room for the body and opening sideways', () => {
    const f = field();
    const nooks = findNooks(f, length, room);
    expect(nooks.length).toBeGreaterThan(0);
    expect(findNooks(field(), length, room)).toEqual(nooks);
    const n = new Float64Array(3);
    for (const k of nooks) {
      const [x, y, z] = k.position;
      expect(k.kind).toBe('cave');
      expect(f.water.sample(x, y, z, n)).toBeGreaterThanOrEqual(0.5 * length);
      expect(k.facing?.[1]).toBe(0);
      expect(Math.hypot(...(k.facing ?? [0, 0, 0]))).toBeCloseTo(1, 12);
    }
  });

  it('deals those with room to turn round first, and fills up with tighter ones', () => {
    const f = field();
    const byCover = findNooks(f, length, 0);
    expect(findNooks(f, length, Infinity)).toEqual(byCover);
    expect(byCover.some((k) => k.radius < room)).toBe(true);
    for (const need of [room, 0.6 * length]) {
      const nooks = findNooks(f, length, need);
      expect(nooks).toHaveLength(byCover.length);
      const roomy = nooks.filter((k) => k.radius >= need).length;
      expect(roomy, `${need / length} L`).toBeGreaterThan(0);
      expect(nooks.slice(0, roomy).every((k) => k.radius >= need)).toBe(true);
    }
  });

  it('finds none in a bare tank', () => {
    const w = nano(spawnMany(royalGramma.id, 1), 1, []);
    expect(w.behaviour.homes).toEqual([]);
    expect(at(w.behaviour.anchor, 0)).toBe(-1);
  });

  it('gives each gramma its own, and none when the scene has a cave', () => {
    const w = nano(spawnMany(royalGramma.id, 2), 1);
    const homes = w.behaviour.homes;
    expect(homes.length).toBeGreaterThanOrEqual(2);
    expect(homes.every((a) => a.id.startsWith('nook:'))).toBe(true);
    const held = [at(w.behaviour.anchor, 0), at(w.behaviour.anchor, 1)];
    expect(held.every((k) => k >= 0)).toBe(true);
    expect(held[0]).not.toBe(held[1]);

    const cave = {
      id: 'cave',
      kind: 'cave' as const,
      position: [0, 0.05, 0.05] as const,
      radius: 0.03,
      facing: [0, 0, 1] as const,
    };
    w.setAnchors([cave]);
    expect(w.behaviour.homes.map((a) => a.id)).toEqual(['cave']);
  });

  it('deals each cave-dweller a crevice of its own, whatever its species', () => {
    const fish = [...spawnMany(royalGramma.id, 2), ...spawnMany(firefish.id, 2)];
    const w = nano(fish, 1, NANO_ROCK, [royalGramma, firefish]);
    const held = Array.from(w.behaviour.anchor);
    const free = w.behaviour.homes.length;
    expect(free).toBeGreaterThanOrEqual(2);
    const dealt = held.filter((k) => k >= 0);
    expect(dealt).toHaveLength(Math.min(fish.length, free));
    expect(new Set(dealt).size).toBe(dealt.length);
    // The same deal again when the rock moves and the crevices are found anew.
    w.setDecor(NANO_ROCK.map((c) => (c.kind === 'sphere' ? { ...c, radius: 0.045 } : c)));
    const again = Array.from(w.behaviour.anchor).filter((k) => k >= 0);
    expect(new Set(again).size).toBe(again.length);
  });

  it('gives a cave to one cave-dweller only, and none to a newcomer of another species', () => {
    const cave = {
      id: 'cave',
      kind: 'cave' as const,
      position: [0, 0.05, 0.05] as const,
      radius: 0.03,
      facing: [0, 0, 1] as const,
    };
    const w = new World({
      seed: 1,
      tank: NANO,
      species: [royalGramma, firefish],
      decor: NANO_ROCK,
      anchors: [cave],
      fish: [...spawnMany(royalGramma.id, 1), ...spawnMany(firefish.id, 1)],
    });
    expect(Array.from(w.behaviour.anchor)).toEqual([0, -1]);
    const i = w.addFish({ id: 'firefish-new', species: firefish.id });
    expect(at(w.behaviour.anchor, i)).toBe(-1);
    w.removeFish('royal-gramma-0');
    const j = w.addFish({ id: 'firefish-late', species: firefish.id });
    expect(at(w.behaviour.anchor, j)).toBe(0);
  });

  it('leaves the bottom-foraging pleco on the sand rather than in a crevice', () => {
    const w = nano(spawnMany(pleco.id, 1), 1, NANO_ROCK, [pleco]);
    expect(w.behaviour.homes).toEqual([]);
  });

  describe('the cached search in a 120 cm tank', () => {
    const TANK = { width: 1.2, height: 0.5, depth: 0.4 } as const;
    const ROCKS: readonly Collider[] = Array.from({ length: 12 }, (_, k): Collider => {
      const x = -0.5 + (k % 6) * 0.2;
      const z = k < 6 ? -0.12 : 0.06;
      return k % 2 === 0
        ? { id: `rock-${k}`, hard: true, kind: 'sphere', center: [x, 0.02, z], radius: 0.07 }
        : {
            id: `rock-${k}`,
            hard: true,
            kind: 'box',
            center: [x, 0.06, z],
            halfExtents: [0.06, 0.06, 0.05],
            rotationY: 0.2 * k,
            rounding: 0.01,
          };
    });
    const basin = Basin.fromTank(TANK);
    const rock = new DecorField(TANK, 0.14);
    const tank = {
      basin,
      rock,
      cover: new UnionSdf([new TankSdf(basin, { surface: false }), rock]),
      water: new UnionSdf([new TankSdf(basin), rock]),
    };
    const fresh = (decor: readonly Collider[]) => {
      const f = new DecorField(TANK, 0.14);
      f.set(decor);
      return findNooks(
        {
          basin,
          rock: f,
          cover: new UnionSdf([new TankSdf(basin, { surface: false }), f]),
          water: new UnionSdf([new TankSdf(basin), f]),
        },
        length,
        room,
      );
    };
    const decor = () => ({ shapes: rock.shapes(), reach: rock.reach });
    const moved = (id: string, change: (c: Collider) => Collider) =>
      ROCKS.map((c) => (c.id === id ? change(c) : c));

    it('tests again only near a rock that moved, and finds what a fresh search finds', () => {
      rock.set(ROCKS);
      const search = new NookSearch();
      expect(search.find(tank, length, room, 'nook:', decor())).toEqual(fresh(ROCKS));
      const full = search.tested;
      const nudged = moved('rock-0', (c) =>
        c.kind === 'sphere' ? { ...c, center: [-0.48, 0.02, -0.12] } : c,
      );
      rock.set(nudged);
      expect(search.find(tank, length, room, 'nook:', decor())).toEqual(fresh(nudged));
      expect(search.tested).toBeGreaterThan(0);
      expect(search.tested).toBeLessThan(0.5 * full);

      rock.set(ROCKS);
      expect(search.find(tank, length, room, 'nook:', decor())).toEqual(fresh(ROCKS));
      rock.set(ROCKS);
      search.find(tank, length, room, 'nook:', decor());
      expect(search.tested).toBe(0);
    });

    it('sees a new shape inside the same bounds, a removed rock and a new length', () => {
      rock.set(ROCKS);
      const search = new NookSearch();
      search.find(tank, length, room, 'nook:', decor());
      const boxed = moved('rock-4', () => ({
        id: 'rock-4',
        hard: true,
        kind: 'box',
        center: [0.3, 0.02, -0.12],
        halfExtents: [0.07, 0.07, 0.07],
        rotationY: 0,
        rounding: 0,
      }));
      const bounds = () => {
        const b = rock.shapes().find((s) => s.id === 'rock-4');
        if (b === undefined) throw new Error('no rock-4');
        return [b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ];
      };
      const sphere = bounds();
      rock.set(boxed);
      bounds().forEach((v, k) => expect(v).toBeCloseTo(sphere[k] ?? NaN, 12));
      expect(search.find(tank, length, room, 'nook:', decor())).toEqual(fresh(boxed));
      expect(search.tested).toBeGreaterThan(0);

      const fewer = boxed.filter((c) => c.id !== 'rock-7');
      rock.set(fewer);
      expect(search.find(tank, length, room, 'nook:', decor())).toEqual(fresh(fewer));

      search.find(tank, 0.9 * length, bodyTurnRoom(0.9 * length), 'nook:', decor());
      const shorter = new NookSearch();
      shorter.find(tank, 0.9 * length, bodyTurnRoom(0.9 * length), 'nook:', decor());
      expect(search.tested).toBe(shorter.tested);
    });

    it('tests again only near a hull rock that moved, and finds what a fresh search finds', () => {
      const stone = (id: string, x: number, z: number, s: number): Collider => ({
        id,
        hard: true,
        kind: 'hull',
        vertices: [
          [x - 0.07 * s, 0, z - 0.05 * s],
          [x + 0.06 * s, 0, z - 0.06 * s],
          [x + 0.07 * s, 0, z + 0.05 * s],
          [x - 0.05 * s, 0, z + 0.06 * s],
          [x - 0.04 * s, 0.09 * s, z - 0.02 * s],
          [x + 0.03 * s, 0.11 * s, z - 0.03 * s],
          [x + 0.04 * s, 0.08 * s, z + 0.03 * s],
          [x - 0.02 * s, 0.1 * s, z + 0.04 * s],
        ],
      });
      const hulled = moved('rock-2', () => stone('rock-2', -0.1, -0.12, 1));
      rock.set(hulled);
      const search = new NookSearch();
      const before = fresh(hulled);
      expect(before.length).toBeGreaterThan(0);
      expect(search.find(tank, length, room, 'nook:', decor())).toEqual(before);
      const nearRock = search.tested;
      const everywhere = new NookSearch();
      everywhere.find(tank, length, room);
      // The rocks stand closer than the reach of a change, so a change near one retests its
      // neighbours too: the saving shows against the whole tank more than against the rock.
      for (const next of [
        hulled.map((c) => (c.id === 'rock-2' ? stone('rock-2', -0.07, -0.1, 1) : c)),
        hulled.map((c) => (c.id === 'rock-2' ? stone('rock-2', -0.07, -0.1, 1.3) : c)),
        [...hulled, stone('rock-12', 0.45, 0.12, 0.8)],
      ]) {
        rock.set(next);
        expect(search.find(tank, length, room, 'nook:', decor())).toEqual(fresh(next));
        expect(search.tested).toBeGreaterThan(0);
        expect(search.tested).toBeLessThan(nearRock);
        expect(search.tested).toBeLessThan(0.25 * everywhere.tested);
      }
    });

    it('matches a fresh search through a seeded run of decor edits', () => {
      const rng = new Rng(1436);
      let decorNow: Collider[] = [...ROCKS];
      rock.set(decorNow);
      const search = new NookSearch();
      search.find(tank, length, room, 'nook:', decor());
      let added = 0;
      let found = 0;
      for (let step = 0; step < 10; step++) {
        const k = Math.floor(rng.range(0, decorNow.length));
        const target = decorNow[k];
        if (target === undefined) throw new Error(`no collider ${k}`);
        const x = rng.range(-0.5, 0.5);
        const z = rng.range(-0.15, 0.15);
        const roll = rng.range(0, 4);
        if (roll < 1) {
          decorNow = decorNow.filter((c) => c.id !== target.id);
        } else if (roll < 2) {
          decorNow.push({
            id: `added-${added++}`,
            hard: true,
            kind: 'hull',
            vertices: [
              [x - 0.05, 0, z - 0.04],
              [x + 0.05, 0, z - 0.05],
              [x + 0.04, 0, z + 0.05],
              [x - 0.04, 0.08, z],
              [x + 0.02, 0.1, z + 0.02],
            ],
          });
        } else if (roll < 3) {
          decorNow[k] = {
            id: target.id,
            hard: true,
            kind: 'sphere',
            center: [x, 0.02, z],
            radius: rng.range(0.04, 0.08),
          };
        } else {
          decorNow[k] = {
            id: target.id,
            hard: true,
            kind: 'box',
            center: [x, 0.05, z],
            halfExtents: [rng.range(0.03, 0.07), 0.05, rng.range(0.03, 0.06)],
            rotationY: rng.range(-1, 1),
            rounding: 0.01,
          };
        }
        rock.set(decorNow);
        const expected = fresh(decorNow);
        found += expected.length;
        expect(search.find(tank, length, room, 'nook:', decor()), `step ${step}`).toEqual(expected);
      }
      expect(found).toBeGreaterThan(0);
    });
  });

  it('finds them again where the rock is moved to', () => {
    const w = nano(spawnMany(royalGramma.id, 1), 1);
    const before = w.behaviour.homes.map((a) => a.position);
    w.setDecor(
      NANO_ROCK.map((c) =>
        c.kind === 'box' ? { ...c, center: [-c.center[0], c.center[1], c.center[2]] as const } : c,
      ),
    );
    const after = w.behaviour.homes.map((a) => a.position);
    expect(after.length).toBeGreaterThan(0);
    expect(after).not.toEqual(before);
    expect(at(w.behaviour.anchor, 0)).toBeGreaterThanOrEqual(0);
  });

  it('a gramma shelters in its crevice through the night', () => {
    for (const seed of [1, 2, 3]) {
      const w = nano(spawnMany(royalGramma.id, 1), seed);
      const nook = w.behaviour.homes[at(w.behaviour.anchor, 0)];
      if (nook === undefined) throw new Error('the gramma got no crevice');
      for (let t = 0; t < 1800; t++) w.step();
      w.setLight(0);
      let inside = 0;
      let night = 0;
      for (let t = 0; t < 9000; t++) {
        w.step();
        if (t < 4500) continue;
        const s = at(w.state, 0);
        const d = Math.hypot(
          at(w.position, 0) - nook.position[0],
          at(w.position, 1) - nook.position[1],
          at(w.position, 2) - nook.position[2],
        );
        if ((s === FishState.Shelter || s === FishState.Rest) && d < nook.radius + length) inside++;
        night++;
      }
      expect(inside / night, `seed ${seed}`).toBeGreaterThan(0.6);
    }
  });
});
