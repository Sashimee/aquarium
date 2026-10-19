import type { Personality } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { FEEDING } from './feeding.ts';
import {
  ARCHETYPES,
  cherryShrimp,
  REEF_ANCHORS,
  REEF_DECOR,
  REEF_TANK,
  SHOW_DECOR,
  SHOW_TANK,
  spawnMany,
} from './fixtures.ts';
import { GREETING, type Visitor } from './greeting.ts';
import { STEP_HZ, World, type FishSpawn } from './world.ts';

const LONG = 120_000;

function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range`);
  return v;
}

function seconds(s: number): number {
  return Math.round(s * STEP_HZ);
}

function tank(fish: FishSpawn[], seed = 3): World {
  const species = [...ARCHETYPES, cherryShrimp];
  return new World({ seed, tank: SHOW_TANK, species, decor: [], fish });
}

function hungry(species: string, count: number, personality?: Personality): FishSpawn[] {
  return spawnMany(species, count).map((f) => ({
    ...f,
    hunger: 1,
    ...(personality === undefined ? {} : { personality }),
  }));
}

/** Fish with their snout within a body length of the stand-off from the front glass. */
function atGlass(w: World): number {
  let n = 0;
  for (let i = 0; i < w.count; i++) {
    const length = at(w.bodyLength, i);
    const standoff = (FEEDING.mouthBodyLengths + GREETING.standoffBodyLengths + 1) * length;
    if (w.basin.maxZ - at(w.position, i * 3 + 2) < standoff) n++;
  }
  return n;
}

function meanDistance(w: World, [x, y]: readonly [number, number]): number {
  let sum = 0;
  for (let i = 0; i < w.count; i++) {
    sum += Math.hypot(
      at(w.position, i * 3) - x,
      at(w.position, i * 3 + 1) - y,
      at(w.position, i * 3 + 2) - w.basin.maxZ,
    );
  }
  return sum / w.count;
}

function active(w: World): number {
  return w.behaviour.greeting.active.reduce((n, a) => n + a, 0);
}

function run(w: World, steps: number, each?: () => void): void {
  for (let t = 0; t < steps; t++) {
    w.step();
    each?.();
  }
}

describe('coming to the glass', { timeout: LONG }, () => {
  it('brings fish that know the visitor to the front glass, clear of it, and holds them there', () => {
    const visitor: [number, number] = [0, 0.25];
    const w = tank(hungry('neon-tetra', 8));
    const quiet = tank(hungry('neon-tetra', 8));
    run(w, seconds(5));
    run(quiet, seconds(5));
    w.setVisitor({ familiarity: 1, at: visitor });
    let worst = Infinity;
    let most = 0;
    let atGlassTime = 0;
    let baselineTime = 0;
    let near = 0;
    let far = 0;
    run(w, seconds(20), () => {
      quiet.step();
      for (let i = 0; i < w.count; i++) worst = Math.min(worst, w.bodyClearance(i));
      const n = atGlass(w);
      most = Math.max(most, n);
      atGlassTime += n;
      baselineTime += atGlass(quiet);
      near += meanDistance(w, visitor);
      far += meanDistance(quiet, visitor);
    });
    expect(worst).toBeGreaterThan(0);
    expect(most).toBeGreaterThanOrEqual(4);
    expect(atGlassTime).toBeGreaterThan(2 * baselineTime);
    expect(near).toBeLessThan(0.7 * far);
    const coming = w.behaviour.greeting.active;
    for (let i = 0; i < w.count; i++) {
      if (coming[i] !== 1) continue;
      expect(Math.abs(at(w.position, i * 3) - visitor[0])).toBeLessThan(
        (GREETING.spreadBodyLengths + 3) * at(w.bodyLength, i),
      );
    }
  });

  it('comes later and less often for a shy fish than a bold one', () => {
    const responders = (boldness: number): number => {
      let n = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const w = tank(hungry('neon-tetra', 1, { boldness, greed: 0.5, sociability: 0.5 }), seed);
        w.setVisitor({ familiarity: 0.8 });
        w.step();
        const phase: unknown = Reflect.get(w.behaviour.greeting, 'phase');
        if (!(phase instanceof Uint8Array)) throw new Error('no phase');
        n += at(phase, 0) === 1 ? 1 : 0;
      }
      return n;
    };
    expect(responders(1)).toBeGreaterThan(responders(0));
  });

  it('sends them back to their own business when the visit ends or their stay runs out', () => {
    const w = tank(hungry('angelfish', 6));
    w.setVisitor({ familiarity: 1 });
    run(w, seconds(GREETING.latencyMaxS + GREETING.shyLatencyS + 1));
    expect(active(w)).toBeGreaterThan(0);
    w.setVisitor(null);
    w.step();
    expect(active(w)).toBe(0);

    w.setVisitor({ familiarity: 1 });
    run(w, seconds(GREETING.latencyMaxS + GREETING.shyLatencyS + GREETING.stayMaxS + 1));
    expect(active(w)).toBe(0);
  });

  it('decides once per visit: moving along the glass changes where fish go, not who comes', () => {
    const w = tank(hungry('angelfish', 6));
    w.setVisitor({ familiarity: 1, at: [-0.3, 0.2] });
    run(w, seconds(8));
    const before = w.rng.state();
    const coming = Array.from(w.behaviour.greeting.active);
    w.setVisitor({ familiarity: 1, at: [0.3, 0.3] });
    w.step();
    expect(Array.from(w.behaviour.greeting.point)).toEqual([0.3, 0.3]);
    expect(Array.from(w.behaviour.greeting.active)).toEqual(coming);
    expect(w.rng.state()).not.toEqual(before);
  });

  it('draws nothing and changes nothing when nobody comes or nobody knows the visitor', () => {
    const plain = tank(hungry('angelfish', 6), 11);
    const stranger = tank(hungry('angelfish', 6), 11);
    const left = tank(hungry('angelfish', 6), 11);
    stranger.setVisitor({ familiarity: 0 });
    left.setVisitor(null);
    run(plain, seconds(15), () => {
      stranger.step();
      left.step();
    });
    expect(active(stranger)).toBe(0);
    expect(stranger.rng.state()).toEqual(plain.rng.state());
    expect(Array.from(stranger.position)).toEqual(Array.from(plain.position));
    expect(Array.from(left.position)).toEqual(Array.from(plain.position));
  });

  it('leaves walkers on the floor and is deterministic', () => {
    const fish = [...hungry('cherry-shrimp', 3), ...hungry('angelfish', 3)];
    const a = tank(fish, 5);
    const b = tank(fish, 5);
    for (const w of [a, b]) w.setVisitor({ familiarity: 1 });
    run(a, seconds(12), () => b.step());
    for (let i = 0; i < 3; i++) expect(at(a.behaviour.greeting.active, i)).toBe(0);
    expect(Array.from(a.position)).toEqual(Array.from(b.position));
  });

  it('keeps a newcomer out of a visit already under way', () => {
    const w = tank(hungry('angelfish', 3));
    w.setVisitor({ familiarity: 1 });
    w.step();
    const i = w.addFish({ id: 'late', species: 'angelfish', hunger: 1 });
    run(w, seconds(12));
    expect(at(w.behaviour.greeting.active, i)).toBe(0);
  });

  it('rejects a malformed visitor and keeps the last one', () => {
    const w = tank(hungry('angelfish', 2));
    w.setVisitor({ familiarity: 0.5, at: [0.1, 0.2] });
    const bad: unknown[] = [
      { familiarity: 2 },
      { familiarity: Number.NaN },
      { familiarity: '1' },
      { familiarity: 1, at: [0, 0.2, 0.1] },
      { familiarity: 1, at: [0, Number.POSITIVE_INFINITY] },
      7,
    ];
    for (const raw of bad) expect(() => w.setVisitor(raw as Visitor)).toThrow(RangeError);
    expect(w.behaviour.greeting.familiarity).toBe(0.5);
    expect(Array.from(w.behaviour.greeting.point)).toEqual([0.1, 0.2]);
  });

  it('takes the middle of the front pane when no spot is given, and moves a spot outside it in', () => {
    const w = tank(hungry('angelfish', 1));
    w.setVisitor({ familiarity: 1 });
    const { basin } = w;
    const ground = basin.ground(0, basin.maxZ);
    expect(Array.from(w.behaviour.greeting.point)).toEqual([0, 0.5 * (ground + basin.maxY)]);
    w.setVisitor({ familiarity: 1, at: [5, -1] });
    expect(Array.from(w.behaviour.greeting.point)).toEqual([basin.maxX, ground]);
  });

  const reefIds = new Set(['blue-tang', 'yellow-tang', 'ocellaris-clownfish', 'royal-gramma']);
  it.each(ARCHETYPES.map((sp) => ({ id: sp.id, reef: reefIds.has(sp.id) })))(
    'never penetrates glass or rock over 10 000 steps of visits along the glass: $id',
    ({ id, reef }) => {
      const steps = 10_000;
      const size = reef ? REEF_TANK : SHOW_TANK;
      const sweep = (visits: boolean) => {
        const w = new World({
          seed: 6,
          tank: size,
          species: ARCHETYPES,
          decor: reef ? REEF_DECOR : SHOW_DECOR,
          anchors: reef ? REEF_ANCHORS : [],
          fish: hungry(id, 4),
        });
        let worst = Infinity;
        let greeted = 0;
        for (let t = 0; t < steps; t++) {
          const phase = t / seconds(40);
          if (visits && t % seconds(40) === 0) w.setVisitor(null);
          if (visits) {
            w.setVisitor({
              familiarity: 1,
              at: [
                0.4 * size.width * Math.sin(2 * Math.PI * phase),
                size.height * (0.5 + 0.35 * Math.sin(2 * Math.PI * 0.37 * phase)),
              ],
            });
          }
          w.step();
          greeted += active(w);
          for (let i = 0; i < w.count; i++) worst = Math.min(worst, w.bodyClearance(i));
        }
        return { worst, greeted, contactRate: w.contacts / (w.count * steps) };
      };
      const visited = sweep(true);
      expect(visited.worst).toBeGreaterThanOrEqual(-1e-9);
      expect(visited.greeted).toBeGreaterThan(0);
      expect(visited.contactRate - sweep(false).contactRate).toBeLessThan(1e-3);
    },
  );
});
