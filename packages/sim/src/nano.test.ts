import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { speciesContentSchema, type Collider } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { Basin } from './basin.ts';
import { DecorField, UnionSdf } from './decor.ts';
import { royalGramma, spawnMany } from './fixtures.ts';
import { findNooks } from './nooks.ts';
import { FishState } from './snapshot.ts';
import { TankSdf } from './sdf.ts';
import { toSimSpecies, type SpeciesInput } from './species.ts';
import { World, maxFishLengthM, type FishSpawn } from './world.ts';

const LONG = 120_000;

/** The nano30 tank's water: 40 × 25 × 30 cm. */
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

  it('finds them deterministically, each with room for the body and opening sideways', () => {
    const f = field();
    const nooks = findNooks(f, length);
    expect(nooks.length).toBeGreaterThan(0);
    expect(findNooks(field(), length)).toEqual(nooks);
    const n = new Float64Array(3);
    for (const k of nooks) {
      const [x, y, z] = k.position;
      expect(k.kind).toBe('cave');
      expect(f.water.sample(x, y, z, n)).toBeGreaterThanOrEqual(0.5 * length);
      expect(k.facing?.[1]).toBe(0);
      expect(Math.hypot(...(k.facing ?? [0, 0, 0]))).toBeCloseTo(1, 12);
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

  it('leaves the bottom-foraging pleco on the sand rather than in a crevice', () => {
    const w = nano(spawnMany(pleco.id, 1), 1, NANO_ROCK, [pleco]);
    expect(w.behaviour.homes).toEqual([]);
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
