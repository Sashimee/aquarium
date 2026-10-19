import { VISIT_WINDOW_DAYS, type Personality } from '@aquarium/shared';
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
import { familiarityFromVisits, GREETING, type Visitor } from './greeting.ts';
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

describe('familiarity from recent visit days', () => {
  it('is 0 for no visit and for today alone, 1 for every day of the window', () => {
    expect(familiarityFromVisits(0)).toBe(0);
    expect(familiarityFromVisits(1)).toBe(0);
    expect(familiarityFromVisits(VISIT_WINDOW_DAYS)).toBe(1);
  });

  it('rises with every extra day, each adding less than the one before', () => {
    let last = 0;
    let lastGain = Infinity;
    for (let d = 2; d <= VISIT_WINDOW_DAYS; d++) {
      const f = familiarityFromVisits(d);
      expect(f).toBeGreaterThan(last);
      expect(f).toBeLessThanOrEqual(1);
      expect(f - last).toBeLessThan(lastGain);
      lastGain = f - last;
      last = f;
    }
  });

  it('rejects counts outside 0 to the window and fractional ones', () => {
    for (const bad of [-1, VISIT_WINDOW_DAYS + 1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => familiarityFromVisits(bad)).toThrow(/recentVisitDays/);
    }
  });
});

describe('coming to the glass', { timeout: LONG }, () => {
  it('brings fish that know the visitor to the front glass, clear of it, and holds them there', () => {
    const visitor: [number, number] = [0, 0.25];
    const w = tank(hungry('neon-tetra', 8));
    const quiet = tank(hungry('neon-tetra', 8));
    run(w, seconds(5));
    run(quiet, seconds(5));
    w.setVisitor({ recentVisitDays: 14, at: visitor });
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
    const responses = (boldness: number): number[] => {
      const waits: number[] = [];
      for (let seed = 1; seed <= 40; seed++) {
        const w = tank(hungry('neon-tetra', 1, { boldness, greed: 0.5, sociability: 0.5 }), seed);
        w.setVisitor({ recentVisitDays: 7 });
        w.step();
        const wait = w.behaviour.greeting.waitLeft(0);
        if (wait !== null) waits.push(wait);
      }
      return waits;
    };
    const shy = responses(0);
    const bold = responses(1);
    expect(shy.length).toBeGreaterThan(0);
    expect(bold.length).toBeGreaterThan(shy.length);
    // Traits move boldness by ±0.2, so the shy latency is 0.4 × shyLatencyS = 1.6 s longer on
    // average, against a 1-3 s uniform draw.
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(shy) - mean(bold)).toBeGreaterThan(1);
  });

  it('brings more fish the more days the owner came, and none the first time', () => {
    const coming = (days: number): number => {
      let n = 0;
      for (let seed = 1; seed <= 10; seed++) {
        const w = tank(hungry('neon-tetra', 8), seed);
        w.setVisitor({ recentVisitDays: days });
        w.step();
        for (let i = 0; i < w.count; i++) n += w.behaviour.greeting.waitLeft(i) === null ? 0 : 1;
      }
      return n;
    };
    const first = coming(1);
    const few = coming(3);
    const every = coming(VISIT_WINDOW_DAYS);
    expect(first).toBe(0);
    expect(few).toBeGreaterThan(0);
    expect(every).toBeGreaterThan(few);
  });

  it('sends them back to their own business when the visit ends or their stay runs out', () => {
    const w = tank(hungry('angelfish', 6));
    w.setVisitor({ recentVisitDays: 14 });
    run(w, seconds(GREETING.latencyMaxS + GREETING.shyLatencyS + 1));
    expect(active(w)).toBeGreaterThan(0);
    w.setVisitor(null);
    w.step();
    expect(active(w)).toBe(0);

    w.setVisitor({ recentVisitDays: 14 });
    run(w, seconds(GREETING.latencyMaxS + GREETING.shyLatencyS + GREETING.stayMaxS + 1));
    expect(active(w)).toBe(0);
  });

  it('decides once per visit: moving along the glass changes where fish go, not who comes', () => {
    const w = tank(hungry('angelfish', 6));
    w.setVisitor({ recentVisitDays: 14, at: [-0.3, 0.2] });
    run(w, seconds(8));
    const before = w.rng.state();
    const coming = Array.from(w.behaviour.greeting.active);
    w.setVisitor({ recentVisitDays: 14, at: [0.3, 0.3] });
    w.step();
    expect(Array.from(w.behaviour.greeting.point)).toEqual([0.3, 0.3]);
    expect(Array.from(w.behaviour.greeting.active)).toEqual(coming);
    expect(w.rng.state()).not.toEqual(before);
  });

  it('draws nothing and changes nothing when nobody comes or nobody knows the visitor', () => {
    const plain = tank(hungry('angelfish', 6), 11);
    const never = tank(hungry('angelfish', 6), 11);
    const firstDay = tank(hungry('angelfish', 6), 11);
    const left = tank(hungry('angelfish', 6), 11);
    never.setVisitor({ recentVisitDays: 0 });
    firstDay.setVisitor({ recentVisitDays: 1 });
    left.setVisitor(null);
    run(plain, seconds(15), () => {
      never.step();
      firstDay.step();
      left.step();
    });
    for (const stranger of [never, firstDay]) {
      expect(active(stranger)).toBe(0);
      expect(stranger.rng.state()).toEqual(plain.rng.state());
      expect(Array.from(stranger.position)).toEqual(Array.from(plain.position));
    }
    expect(Array.from(left.position)).toEqual(Array.from(plain.position));
  });

  it('leaves walkers on the floor and is deterministic', () => {
    const fish = [...hungry('cherry-shrimp', 3), ...hungry('angelfish', 3)];
    const a = tank(fish, 5);
    const b = tank(fish, 5);
    for (const w of [a, b]) w.setVisitor({ recentVisitDays: 14 });
    run(a, seconds(12), () => b.step());
    for (let i = 0; i < 3; i++) expect(at(a.behaviour.greeting.active, i)).toBe(0);
    expect(Array.from(a.position)).toEqual(Array.from(b.position));
  });

  it('keeps a newcomer out of a visit already under way', () => {
    const w = tank(hungry('angelfish', 3));
    w.setVisitor({ recentVisitDays: 14 });
    w.step();
    const i = w.addFish({ id: 'late', species: 'angelfish', hunger: 1 });
    run(w, seconds(12));
    expect(at(w.behaviour.greeting.active, i)).toBe(0);
  });

  it('rejects a malformed visitor and keeps the last one', () => {
    const w = tank(hungry('angelfish', 2));
    w.setVisitor({ recentVisitDays: 5, at: [0.1, 0.2] });
    const bad: unknown[] = [
      { recentVisitDays: 15 },
      { recentVisitDays: Number.NaN },
      { recentVisitDays: '1' },
      { recentVisitDays: -1 },
      { recentVisitDays: 2.5 },
      {},
      { recentVisitDays: 14, at: [0, 0.2, 0.1] },
      { recentVisitDays: 14, at: [0, Number.POSITIVE_INFINITY] },
      7,
    ];
    for (const raw of bad) expect(() => w.setVisitor(raw as Visitor)).toThrow(RangeError);
    expect(w.behaviour.greeting.familiarity).toBe(familiarityFromVisits(5));
    expect(Array.from(w.behaviour.greeting.point)).toEqual([0.1, 0.2]);
  });

  it('takes the middle of the front pane when no spot is given, and moves a spot outside it in', () => {
    const w = tank(hungry('angelfish', 1));
    w.setVisitor({ recentVisitDays: 14 });
    const { basin } = w;
    const ground = basin.ground(0, basin.maxZ);
    expect(Array.from(w.behaviour.greeting.point)).toEqual([0, 0.5 * (ground + basin.maxY)]);
    w.setVisitor({ recentVisitDays: 14, at: [5, -1] });
    expect(Array.from(w.behaviour.greeting.point)).toEqual([basin.maxX, ground]);
  });

  const reefIds = new Set(['blue-tang', 'yellow-tang', 'ocellaris-clownfish', 'royal-gramma']);
  it.each(
    ARCHETYPES.map((sp) => ({
      id: sp.id,
      reef: reefIds.has(sp.id),
      glassGrazer: sp.behaviour.traits.includes('glass-grazer'),
    })),
  )(
    'never penetrates glass or rock over 10 000 steps of visits along the glass: $id',
    ({ id, reef, glassGrazer }) => {
      const steps = 10_000;
      const size = reef ? REEF_TANK : SHOW_TANK;
      const sweep = (visits: boolean, seed: number) => {
        const w = new World({
          seed,
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
              recentVisitDays: 14,
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
      const visited = sweep(true, 1);
      expect(visited.worst).toBeGreaterThanOrEqual(-1e-9);
      expect(visited.greeted).toBeGreaterThan(0);
      // A glass grazer touches the pane by design, so the contacts visits add to it swing by ten
      // times this limit either way between seeds and say nothing about steering.
      if (glassGrazer) return;
      expect(visited.contactRate - sweep(false, 1).contactRate).toBeLessThan(1e-3);
    },
  );
});
