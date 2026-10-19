import type { Collider } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { DecorField } from './decor.ts';
import {
  ARCHETYPES,
  benchmarkConfig,
  FoodRain,
  REEF_ANCHORS,
  REEF_DECOR,
  REEF_TANK,
  spawnMany,
} from './fixtures.ts';
import { MAX_FOOD_PARTICLES } from './food.ts';
import { wrapAngle } from './math.ts';
import { World, type FishSpawn, type WorldConfig } from './world.ts';

// Long simulations: well under a second locally, but shared CI runners can be several times slower.
const LONG = 60_000;

type Typed = Float64Array | Int32Array | Int8Array | Uint8Array | Uint16Array | Uint32Array;

/** Arrays holding fish indices; compared by the id of the fish they point at. */
const FISH_INDEX_ARRAYS = new Set(['schoolNbr', 'anyNbr', 'territoryTarget', 'follow']);
/**
 * Rebuilt before every read (`distSq`, and `neighbourOrder`, re-sorted from whatever it held) or
 * scratch within one call (the rest).
 */
const SCRATCH = new Set([
  'distSq',
  'neighbourOrder',
  'lost',
  'lostNext',
  'normal',
  'probeNormal',
  'previous',
  'turnNormal',
  'n3',
]);

function fieldName(name: string): string {
  return name.replace(/^_/, '');
}

/**
 * Thirteen fish, a count no per-species or per-particle array length is a multiple of, so every
 * typed array whose length is a multiple of the fish count really is a per-fish array.
 */
function community(seed: number): WorldConfig {
  return {
    seed,
    tank: REEF_TANK,
    species: ARCHETYPES,
    decor: REEF_DECOR,
    anchors: REEF_ANCHORS,
    fish: [
      ...spawnMany('neon-tetra', 6),
      ...spawnMany('bronze-corydoras', 2),
      ...spawnMany('angelfish', 1),
      ...spawnMany('blue-tang', 1),
      ...spawnMany('ocellaris-clownfish', 2),
      ...spawnMany('betta', 1),
    ],
  };
}

function owners(w: World): Record<string, object> {
  return { world: w, behaviour: w.behaviour, feeding: w.behaviour.feeding };
}

function isTyped(v: unknown): v is Typed {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

function field<T>(owner: object, name: string): T {
  const v: unknown = Reflect.get(owner, name);
  if (v === undefined) throw new Error(`no field "${name}"`);
  return v as T;
}

/** Every per-fish typed array of the world, its behaviour and its feeding, keyed `owner.field`. */
function perFishArrays(w: World): Map<string, Typed> {
  const out = new Map<string, Typed>();
  for (const [ownerName, owner] of Object.entries(owners(w))) {
    for (const [name, v] of Object.entries(owner)) {
      if (!isTyped(v) || SCRATCH.has(fieldName(name))) continue;
      // Public arrays sit in `_name` fields behind readonly getters.
      const key = `${ownerName}.${fieldName(name)}`;
      if (v.length > 0 && v.length % w.count === 0) out.set(key, v);
    }
  }
  return out;
}

type Row = (number | string | null)[];

/** Each fish's slice of every per-fish array, keyed by fish id, fish indices turned into ids. */
function rowsById(w: World): Map<string, Map<string, Row>> {
  const rows = new Map<string, Map<string, Row>>();
  for (const id of w.fishIds) rows.set(id, new Map());
  for (const [key, a] of perFishArrays(w)) {
    const width = a.length / w.count;
    const name = key.slice(key.indexOf('.') + 1);
    w.fishIds.forEach((id, i) => {
      const values = Array.from(a.subarray(i * width, (i + 1) * width));
      let row: Row = values;
      if (FISH_INDEX_ARRAYS.has(name)) row = values.map((j) => (j < 0 ? null : idAt(w, j)));
      else if (name === 'schoolGroup') {
        row = values.map((g) => (g < 0 ? `alone:${idAt(w, -1 - g)}` : g));
      }
      rows.get(id)?.set(key, row);
    });
  }
  return rows;
}

function idAt(w: World, i: number): string {
  const id = w.fishIds[i];
  if (id === undefined) throw new RangeError(`fish index ${i} out of range (${w.count} fish)`);
  return id;
}

function indexOf(w: World, id: string): number {
  const i = w.fishIds.indexOf(id);
  if (i < 0) throw new Error(`no fish "${id}"`);
  return i;
}

function feedFor(w: World, rain: FoodRain, steps: number): void {
  for (let t = 0; t < steps; t++) {
    rain.feed(w);
    w.step();
    rain.eat(w.takeAteEvents());
  }
}

function fed(seed: number, steps: number): { w: World; rain: FoodRain } {
  const w = new World(community(seed));
  const rain = new FoodRain(REEF_TANK);
  rain.sprinkle('flakes', 40, 0, 0, 0.4);
  rain.sprinkle('pellets', 20, -0.3, 0.1, 0.3);
  feedFor(w, rain, steps);
  return { w, rain };
}

/** FNV-1a over every typed array of the world, its behaviour and feeding, the ids and the RNG. */
function worldHash(w: World): number {
  let h = 0x811c9dc5;
  const mix = (bytes: Uint8Array): void => {
    for (const b of bytes) h = Math.imul(h ^ b, 0x01000193);
  };
  for (const owner of Object.values(owners(w))) {
    for (const [name, v] of Object.entries(owner)) {
      if (!isTyped(v) || SCRATCH.has(fieldName(name))) continue;
      mix(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    }
  }
  mix(new TextEncoder().encode(w.fishIds.join('\n')));
  const reach = ['hardDecor', 'softDecor'].map((name) => field<DecorField>(w, name).reach);
  mix(new Uint8Array(new Float64Array(reach).buffer));
  const s = w.rng.state();
  mix(new Uint8Array(new Uint32Array([s.a, s.b, s.c, s.d]).buffer));
  return h >>> 0;
}

const NEWCOMER: FishSpawn = { id: 'newcomer', species: 'yellow-tang' };

/**
 * Per-fish arrays a fish fills from its spawn spot or its own RNG draws, and the neighbour lists,
 * which every step rebuilds before reading (a joining fish's start empty rather than at fish 0).
 */
const SPAWN_DRAWN = new Set([
  'behaviour.crawlSign',
  'behaviour.excursionTimer',
  'behaviour.forageTimer',
  'behaviour.grazeNext',
  'behaviour.home',
  'behaviour.homeTimer',
  'behaviour.restTau',
  'behaviour.territoryCheck',
  'world.anyNbr',
  'world.position',
  'world.schoolNbr',
  'world.scrapeAnchor',
  'world.targetYaw',
  'world.yaw',
]);

/** Steps both worlds and expects them to stay bit-identical. */
function expectSameFuture(a: World, b: World, steps: number): void {
  for (let t = 0; t < steps; t++) {
    a.step();
    b.step();
  }
  expect(Array.from(a.position)).toEqual(Array.from(b.position));
  expect(worldHash(a)).toBe(worldHash(b));
}

describe('adding a fish to a running world', () => {
  it('appends it to every per-fish array and leaves every other fish exactly as it was', () => {
    const { w } = fed(4, 400);
    const before = rowsById(w);
    const widths = new Map([...perFishArrays(w)].map(([k, a]) => [k, a.length / w.count]));
    const n = w.count;

    const i = w.addFish(NEWCOMER, { position: [0.3, 0.4, 0.15], heading: 1 });

    expect(i).toBe(n);
    expect(w.count).toBe(n + 1);
    expect(w.fishIds).toEqual([...before.keys(), 'newcomer']);
    for (const [key, a] of perFishArrays(w)) {
      expect(a.length, key).toBe((n + 1) * (widths.get(key) ?? NaN));
    }
    expect([...perFishArrays(w).keys()].sort()).toEqual([...widths.keys()].sort());
    const after = rowsById(w);
    for (const [id, row] of before) expect(after.get(id), id).toEqual(row);
    expect(w.behaviour.plans).toHaveLength(n + 1);
  });

  it('starts at the requested spot and heading when the water there is free', () => {
    const w = new World(community(1));
    const i = w.addFish(NEWCOMER, { position: [0.3, 0.4, 0.15], heading: 7 });
    expect(Array.from(w.position.subarray(i * 3, i * 3 + 3))).toEqual([0.3, 0.4, 0.15]);
    expect(w.yaw[i]).toBeCloseTo(wrapAngle(7), 12);
    expect(w.bodyClearance(i)).toBeGreaterThan(0);
  });

  it('clamps a spot outside the tank to a body length inside the glass, sand and surface', () => {
    const w = new World(community(1));
    const i = w.addFish(NEWCOMER, { position: [5, 3, -4], heading: 0 });
    const { basin } = w;
    const pad = 2 * (w.radius[i] ?? NaN);
    const [x, y, z] = Array.from(w.position.subarray(i * 3, i * 3 + 3));
    expect(x).toBeCloseTo(basin.maxX - pad, 12);
    expect(y).toBeCloseTo(basin.maxY - pad, 12);
    expect(z).toBeCloseTo(basin.minZ + pad, 12);
    expect(w.bodyClearance(i)).toBeGreaterThan(0);

    const low = w.addFish(
      { id: 'low', species: 'neon-tetra' },
      { position: [0, -1, 0], heading: 0 },
    );
    const lowPad = 2 * (w.radius[low] ?? NaN);
    expect(w.position[low * 3 + 1]).toBeCloseTo(basin.ground(0, 0) + lowPad, 12);
  });

  it('pushes a spot inside rock out to free water next to it', () => {
    const w = new World(community(1));
    const inRock: [number, number, number] = [-0.55, 0.1, -0.1];
    const i = w.addFish(NEWCOMER, { position: inRock, heading: 0 });
    const p = Array.from(w.position.subarray(i * 3, i * 3 + 3));
    const fromCentre = Math.hypot((p[0] ?? 0) + 0.55, p[1] ?? 0, (p[2] ?? 0) + 0.1);
    expect(fromCentre).toBeGreaterThan(0.2);
    expect(fromCentre).toBeLessThan(0.2 + 4 * (w.radius[i] ?? NaN));
    expect(w.bodyClearance(i)).toBeGreaterThan(0);
  });

  it('spawns without a spot the way fish spawn at construction, from the world RNG', () => {
    const a = new World(community(9));
    const b = new World(community(9));
    const i = a.addFish(NEWCOMER);
    b.addFish(NEWCOMER);
    expect(Array.from(a.position)).toEqual(Array.from(b.position));
    expect(a.bodyClearance(i)).toBeGreaterThan(0);
    const c = new World(community(10));
    c.addFish(NEWCOMER);
    expect(c.position.subarray(i * 3, i * 3 + 3)).not.toEqual(
      a.position.subarray(i * 3, i * 3 + 3),
    );
  });

  it('gives a host fish an anchor and keeps its own species pair on theirs', () => {
    const w = new World(community(2));
    const pair = ['ocellaris-clownfish-0', 'ocellaris-clownfish-1'].map((id) => indexOf(w, id));
    const held = pair.map((i) => w.behaviour.anchor[i]);
    const i = w.addFish({ id: 'clown-2', species: 'ocellaris-clownfish' });
    expect(pair.map((j) => w.behaviour.anchor[j])).toEqual(held);
    expect(w.behaviour.anchor[i]).toBe(REEF_ANCHORS.findIndex((a) => a.kind === 'anemone'));
  });

  it('widens the decor field for a fish longer than any already in the tank', () => {
    const w = new World({ ...community(3), fish: spawnMany('neon-tetra', 6) });
    const field = w.decorSdf;
    if (!(field instanceof DecorField)) throw new Error('expected the reef decor field');
    const narrow = field.reach;
    const i = w.addFish({ id: 'tang', species: 'blue-tang' });
    expect(field.reach).toBeGreaterThan(narrow);
    expect(field.reach).toBeGreaterThanOrEqual(2 * (w.bodyLength[i] ?? NaN));
  });

  it('gives a newcomer the same starting state a fish spawned at construction gets', () => {
    const born = new World({ ...community(1), fish: [...community(1).fish, NEWCOMER] });
    const added = new World(community(1));
    const i = added.addFish(NEWCOMER);
    const bornRows = perFishArrays(born);
    const checked: string[] = [];
    for (const [key, a] of perFishArrays(added)) {
      const width = a.length / added.count;
      const row = Array.from(a.subarray(i * width, (i + 1) * width));
      const b = bornRows.get(key);
      if (b === undefined) throw new Error(`${key} missing from the constructed world`);
      const expected = Array.from(b.subarray(i * width, (i + 1) * width));
      if (SPAWN_DRAWN.has(key)) continue;
      expect(row, key).toEqual(expected);
      checked.push(key);
    }
    expect(checked).toEqual(
      expect.arrayContaining(['behaviour.startleAt', 'behaviour.startledAt', 'feeding.retarget']),
    );
  });

  it('rejects a duplicate id, an unknown species and a bad spot without changing anything', () => {
    const w = new World({ ...community(5), fish: spawnMany('neon-tetra', 8) });
    const twin = new World({ ...community(5), fish: spawnMany('neon-tetra', 8) });
    w.step();
    twin.step();
    const hash = worldHash(w);
    const tang = { id: 'tang', species: 'blue-tang' };
    expect(() => w.addFish({ id: 'neon-tetra-0', species: 'neon-tetra' })).toThrow(
      /already in the world/,
    );
    expect(() => w.addFish({ id: 'x', species: 'goldfish' })).toThrow(/unknown species/);
    expect(() => w.addFish(tang, { position: [0, NaN, 0], heading: 0 })).toThrow(/finite/);
    expect(() => w.addFish(tang, { position: [0, 0.2, 0], heading: Infinity })).toThrow(/finite/);
    const short = { position: [0, 0.2] as unknown as [number, number, number], heading: 0 };
    expect(() => w.addFish(tang, short)).toThrow(/finite \[x, y, z\]/);
    expect(worldHash(w)).toBe(hash);
    expectSameFuture(w, twin, 900);
  });

  it('takes back RNG draws and the wider decor reach when no free water is found', () => {
    const config = { ...community(6), fish: spawnMany('neon-tetra', 8) };
    const w = new World(config);
    const twin = new World(config);
    const solid: Collider = {
      id: 'solid',
      hard: true,
      kind: 'box',
      center: [0, 0.3, 0],
      halfExtents: [1, 0.4, 0.4],
      rotationY: 0,
      rounding: 0,
    };
    for (const v of [w, twin]) {
      for (let t = 0; t < 30; t++) v.step();
      v.setDecor([...REEF_DECOR, solid]);
    }
    const hash = worldHash(w);
    const tang = { id: 'tang', species: 'blue-tang' };
    const draws = w.rng.state();
    expect(() => w.addFish(tang)).toThrow(/no free water to spawn in/);
    expect(() => w.addFish(tang, { position: [0, 0.3, 0], heading: 0 })).toThrow(
      /no free water near/,
    );
    expect(w.rng.state()).toEqual(draws);
    expect(worldHash(w)).toBe(hash);
    for (const v of [w, twin]) v.setDecor(REEF_DECOR);
    expect(worldHash(w)).toBe(worldHash(twin));
    expectSameFuture(w, twin, 900);
  });

  it('keeps the newcomer and everyone else out of glass and rock', { timeout: LONG }, () => {
    const { w, rain } = fed(6, 30);
    w.addFish(NEWCOMER, { position: [-0.55, 0.1, -0.1], heading: 2 });
    w.addFish({ id: 'tetra-x', species: 'neon-tetra' }, { position: [9, 9, 9], heading: 0 });
    w.addFish({ id: 'cory-x', species: 'bronze-corydoras' });
    let worst = Infinity;
    for (let t = 0; t < 3000; t++) {
      rain.feed(w);
      w.step();
      rain.eat(w.takeAteEvents());
      for (let i = 0; i < w.count; i++) worst = Math.min(worst, w.bodyClearance(i));
    }
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
  });
});

describe('removing a fish from a running world', () => {
  it('drops its row everywhere and leaves every other fish as it was, but for references to it', () => {
    const { w } = fed(4, 400);
    const gone = 'neon-tetra-2';
    const before = rowsById(w);
    const widths = new Map([...perFishArrays(w)].map(([k, a]) => [k, a.length / w.count]));
    const n = w.count;
    const referenced = [...before.values()].some((row) =>
      [...row.entries()].some(
        ([key, values]) =>
          FISH_INDEX_ARRAYS.has(key.slice(key.indexOf('.') + 1)) && values.includes(gone),
      ),
    );
    expect(referenced).toBe(true);

    w.removeFish(gone);

    expect(w.count).toBe(n - 1);
    expect(w.fishIds).toEqual([...before.keys()].filter((id) => id !== gone));
    for (const [key, a] of perFishArrays(w)) {
      expect(a.length, key).toBe((n - 1) * (widths.get(key) ?? NaN));
    }
    expect(w.behaviour.plans).toHaveLength(n - 1);
    const after = rowsById(w);
    for (const [id, row] of before) {
      if (id === gone) continue;
      const expected = new Map<string, Row>();
      for (const [key, values] of row) {
        const name = key.slice(key.indexOf('.') + 1);
        expected.set(
          key,
          FISH_INDEX_ARRAYS.has(name) ? values.map((v) => (v === gone ? null : v)) : values,
        );
      }
      if (row.get('behaviour.territoryTarget')?.[0] === gone) {
        expected.set('behaviour.territoryPhase', [0]);
      }
      expect(after.get(id), id).toEqual(expected);
    }
  });

  it('leaves no fish following, contesting or schooling with the fish that left', () => {
    const { w, rain } = fed(7, 0);
    let followed = -1;
    for (let t = 0; t < 3000 && followed < 0; t++) {
      feedFor(w, rain, 1);
      followed = Array.from(w.behaviour.feeding.follow).find((j) => j >= 0) ?? -1;
    }
    expect(followed).toBeGreaterThanOrEqual(0);
    const gone = idAt(w, followed);
    const followers = w.fishIds.filter((_, i) => w.behaviour.feeding.follow[i] === followed);
    const rival = indexOf(w, 'betta-0');
    const contester = indexOf(w, 'ocellaris-clownfish-0');
    w.behaviour.territoryTarget[rival] = followed;
    field<Uint8Array>(w.behaviour, 'territoryPhase')[rival] = 2;
    w.behaviour.territoryTarget[contester] = indexOf(w, 'ocellaris-clownfish-1');
    field<Uint8Array>(w.behaviour, 'territoryPhase')[contester] = 1;

    w.removeFish(gone);

    const rows = rowsById(w);
    for (const [id, row] of rows) {
      for (const [key, values] of row) expect(values, `${id} ${key}`).not.toContain(gone);
    }
    for (const id of followers) expect(w.behaviour.feeding.follow[indexOf(w, id)], id).toBe(-1);
    expect(w.behaviour.territoryTarget[indexOf(w, 'betta-0')]).toBe(-1);
    expect(field<Uint8Array>(w.behaviour, 'territoryPhase')[indexOf(w, 'betta-0')]).toBe(0);
    const stillContesting = indexOf(w, 'ocellaris-clownfish-0');
    expect(w.behaviour.territoryTarget[stillContesting]).toBe(indexOf(w, 'ocellaris-clownfish-1'));
    expect(field<Uint8Array>(w.behaviour, 'territoryPhase')[stillContesting]).toBe(1);
    const held = [
      field<Int32Array>(w, 'schoolNbr'),
      field<Int32Array>(w, 'anyNbr'),
      w.behaviour.feeding.follow,
    ];
    for (const a of held) for (const j of a) expect(j).toBeLessThan(w.count);
    feedFor(w, rain, 300);
  });

  it('drops its feeding claims and renumbers the others', () => {
    const { w, rain } = fed(8, 0);
    const claimers = (): number[] => {
      const all: number[] = [];
      for (let k = 0; k < MAX_FOOD_PARTICLES; k++) all.push(...w.behaviour.feeding.claimants(k));
      return all;
    };
    for (let t = 0; t < 3000 && new Set(claimers()).size < 3; t++) feedFor(w, rain, 1);
    const held = claimers();
    expect(new Set(held).size).toBeGreaterThanOrEqual(3);
    const claims = new Map<number, string[]>();
    for (let k = 0; k < MAX_FOOD_PARTICLES; k++) {
      claims.set(
        k,
        w.behaviour.feeding.claimants(k).map((j) => idAt(w, j)),
      );
    }
    // The lowest-numbered claimant, so the others' indices all shift down.
    const gone = idAt(w, Math.min(...held));

    w.removeFish(gone);

    for (const [k, ids] of claims) {
      const now = w.behaviour.feeding.claimants(k).map((j) => idAt(w, j));
      expect(now, `particle ${k}`).toEqual(ids.filter((id) => id !== gone));
    }
    feedFor(w, rain, 300);
  });

  it('renumbers a station group leader and hands the group on when the leader leaves', () => {
    const w = new World({
      ...community(2),
      fish: [...spawnMany('neon-tetra', 2), ...spawnMany('otocinclus', 4)],
    });
    const si = w.speciesIndex[indexOf(w, 'otocinclus-0')] ?? -1;
    expect(field<Int32Array>(w.behaviour, 'groupLeader')[si]).toBe(indexOf(w, 'otocinclus-0'));

    w.removeFish('neon-tetra-0');
    expect(field<Int32Array>(w.behaviour, 'groupLeader')[si]).toBe(indexOf(w, 'otocinclus-0'));
    expect(field<Int32Array>(w.behaviour, 'groupSize')[si]).toBe(4);
    w.removeFish('otocinclus-0');

    expect(field<Int32Array>(w.behaviour, 'groupLeader')[si]).toBe(indexOf(w, 'otocinclus-1'));
    expect(field<Int32Array>(w.behaviour, 'groupSize')[si]).toBe(3);
    w.removeFish('otocinclus-3');
    expect(field<Int32Array>(w.behaviour, 'groupLeader')[si]).toBe(indexOf(w, 'otocinclus-1'));
    expect(field<Int32Array>(w.behaviour, 'groupSize')[si]).toBe(2);
    for (let t = 0; t < 300; t++) w.step();
  });

  it('fails loudly on an unknown id and changes nothing', () => {
    const w = new World(community(5));
    w.step();
    const hash = worldHash(w);
    expect(() => w.removeFish('ghost')).toThrow(/no fish "ghost"/);
    expect(worldHash(w)).toBe(hash);
  });

  it('can empty the tank and refill it', () => {
    const w = new World({ ...community(5), fish: spawnMany('neon-tetra', 2) });
    w.removeFish('neon-tetra-0');
    w.removeFish('neon-tetra-1');
    expect(w.count).toBe(0);
    w.step();
    w.addFish(NEWCOMER);
    for (let t = 0; t < 30; t++) w.step();
    expect(w.fishIds).toEqual(['newcomer']);
    expect(w.bodyClearance(0)).toBeGreaterThanOrEqual(-1e-9);
  });
});

describe('add and remove determinism', () => {
  function script(seed: number): number {
    const { w, rain } = fed(seed, 0);
    for (let t = 0; t < 600; t++) {
      if (t === 100) w.addFish(NEWCOMER, { position: [0.2, 0.3, 0], heading: 0.5 });
      if (t === 200) w.removeFish('neon-tetra-2');
      if (t === 300) w.addFish({ id: 'cory-x', species: 'bronze-corydoras' });
      if (t === 400) w.removeFish('newcomer');
      feedFor(w, rain, 1);
    }
    return worldHash(w);
  }

  it('gives the same world for the same changes at the same steps', { timeout: LONG }, () => {
    const a = script(11);
    expect(script(11)).toBe(a);
    expect(script(12)).not.toBe(a);
  });

  it('still steps the 60-fish benchmark after churn without per-step growth', () => {
    const w = new World(benchmarkConfig(3));
    w.removeFish('neon-tetra-0');
    w.addFish({ id: 'neon-tetra-60', species: 'neon-tetra' });
    const arrays = perFishArrays(w);
    for (let t = 0; t < 60; t++) w.step();
    for (const [key, a] of perFishArrays(w)) expect(a, key).toBe(arrays.get(key));
  });
});
