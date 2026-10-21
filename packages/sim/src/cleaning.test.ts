import type { Collider } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { BEHAVIOUR } from './behaviour.ts';
import { CLEANING, poseOf, VisitPhase } from './cleaning.ts';
import {
  ARCHETYPES,
  cleanerWrasse,
  REEF_ANCHORS,
  REEF_DECOR,
  REEF_TANK,
  spawnMany,
} from './fixtures.ts';
import { FishState } from './snapshot.ts';
import { STEP_HZ, World, type FishSpawn } from './world.ts';

const LONG = 120_000;
const SPECIES = [...ARCHETYPES, cleanerWrasse];

function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range`);
  return v;
}

function seconds(s: number): number {
  return Math.round(s * STEP_HZ);
}

function reef(fish: FishSpawn[], seed = 5, decor: readonly Collider[] = REEF_DECOR): World {
  return new World({ seed, tank: REEF_TANK, species: SPECIES, decor, anchors: REEF_ANCHORS, fish });
}

/** A wrasse and eight reef clients of four species. */
function community(): FishSpawn[] {
  return [
    ...spawnMany('cleaner-wrasse', 1),
    ...spawnMany('yellow-tang', 3),
    ...spawnMany('ocellaris-clownfish', 2),
    ...spawnMany('royal-gramma', 1),
    ...spawnMany('blue-tang', 2),
  ];
}

/** The community with a school of neon tetras, small clients half a wrasse long. */
function mixed(): FishSpawn[] {
  return [...community(), ...spawnMany('neon-tetra', 6)];
}

/** How far the wrasse's centre is from client `s`'s spine, as it now lies. */
function offSpine(w: World, s: number): number {
  const ls = at(w.bodyLength, s);
  const y = at(w.yaw, s);
  const p = at(w.pitch, s);
  const fx = Math.sin(y) * Math.cos(p);
  const fy = Math.sin(p);
  const fz = Math.cos(y) * Math.cos(p);
  const dx = at(w.position, 0) - at(w.position, s * 3);
  const dy = at(w.position, 1) - at(w.position, s * 3 + 1);
  const dz = at(w.position, 2) - at(w.position, s * 3 + 2);
  const half = CLEANING.bodyAxisBodyLengths * ls;
  const a = Math.max(-half, Math.min(half, dx * fx + dy * fy + dz * fz));
  return Math.hypot(dx - a * fx, dy - a * fy, dz - a * fz);
}

function station(w: World, c: number): [number, number, number] {
  const s = w.behaviour.cleaning.station;
  return [at(s, c * 3), at(s, c * 3 + 1), at(s, c * 3 + 2)];
}

function posing(w: World): number[] {
  const out: number[] = [];
  for (let i = 0; i < w.count; i++) {
    if (at(w.behaviour.cleaning.phase, i) === VisitPhase.Posing) out.push(i);
  }
  return out;
}

/** Steps until some client holds its pose at the station; returns it. */
function untilPosed(w: World, limit = seconds(600)): number {
  const c = w.behaviour.cleaning;
  for (let t = 0; t < limit; t++) {
    w.step();
    for (const i of posing(w)) if (at(c.arrived, i) === 1) return i;
  }
  throw new Error('no client posed at the station');
}

describe('station choice', () => {
  it('depends on the layout alone, not on the seed or where the fish start', () => {
    const stations = [1, 2, 3].map((seed) => {
      const w = reef(community(), seed);
      w.step();
      return station(w, 0);
    });
    for (const s of stations) expect(s).toEqual(stations[0]);
  });

  it('sits in clear water beside the tallest rock, within the wrasse band', () => {
    const w = reef(community());
    w.step();
    const [x, y, z] = station(w, 0);
    const decor = w.decorSdf;
    if (decor === null) throw new Error('reef tank has hard decor');
    const n = new Float64Array(3);
    const lc = cleanerWrasse.locomotion.bodyLengthM;
    const d = decor.sample(x, y, z, n);
    expect(d).toBeGreaterThanOrEqual(CLEANING.stationStandoffBodyLengths * lc - 1e-9);
    expect(d).toBeLessThan(3 * lc);
    expect(w.sceneSdf.sample(x, y, z, n)).toBeGreaterThan(at(w.radius, 0));
    // rock-left and rock-right both top out at 0.2 m; the tie goes to the first id.
    expect(Math.hypot(x + 0.55, z + 0.1)).toBeLessThan(0.2 + 3 * lc);
    const [lo, hi] = cleanerWrasse.behaviour.depthBand;
    expect(y).toBeGreaterThan(lo * REEF_TANK.height - lc);
    expect(y).toBeLessThan(hi * REEF_TANK.height + lc);
  });

  it('moves when its rock is taken away, and again the same way every time', () => {
    const run = (): [number, number, number] => {
      const w = reef(community());
      w.step();
      w.setDecor(REEF_DECOR.filter((c) => c.id !== 'rock-left'));
      w.step();
      return station(w, 0);
    };
    const moved = run();
    expect(Math.hypot(moved[0] + 0.55, moved[2] + 0.1)).toBeGreaterThan(0.3);
    expect(run()).toEqual(moved);
  });

  it('gives two wrasse stations at different rocks', () => {
    const w = reef([...spawnMany('cleaner-wrasse', 2), ...spawnMany('yellow-tang', 2)]);
    w.step();
    const [a, b] = [station(w, 0), station(w, 1)];
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeGreaterThan(0.3);
  });

  it('falls back to mid-water in a bare tank', () => {
    const w = reef([...spawnMany('cleaner-wrasse', 1), ...spawnMany('yellow-tang', 1)], 5, []);
    w.step();
    const [x, y, z] = station(w, 0);
    expect(x).toBeCloseTo(0, 9);
    expect(z).toBeCloseTo(0, 9);
    const [lo, hi] = cleanerWrasse.behaviour.depthBand;
    expect(y).toBeCloseTo(0.5 * (lo + hi) * REEF_TANK.height, 9);
  });
});

describe('visits', { timeout: LONG }, () => {
  it('every client comes in time, never again within the minimum interval', () => {
    const w = reef(community());
    const c = w.behaviour.cleaning;
    const visits = new Array<number>(w.count).fill(0);
    const ended = new Array<number>(w.count).fill(-Infinity);
    let previous = Array.from(c.phase);
    for (let t = 0; t < seconds(1800); t++) {
      w.step();
      for (let i = 1; i < w.count; i++) {
        const was = at(previous, i);
        const now = at(c.phase, i);
        if (was === VisitPhase.None && now !== VisitPhase.None) {
          visits[i] = at(visits, i) + 1;
          expect((w.tick - at(ended, i)) / STEP_HZ).toBeGreaterThanOrEqual(
            CLEANING.visitMinIntervalS,
          );
        }
        if (was !== VisitPhase.None && now === VisitPhase.None) ended[i] = w.tick;
      }
      previous = Array.from(c.phase);
    }
    expect(at(c.phase, 0)).toBe(VisitPhase.None);
    for (let i = 1; i < w.count; i++) expect(at(visits, i), `client ${i}`).toBeGreaterThan(0);
    const total = visits.reduce((a, b) => a + b, 0);
    // Eight clients at a mean interval near 300 s over 30 minutes: tens of visits, not hundreds.
    expect(total).toBeGreaterThan(20);
    expect(total).toBeLessThan(100);
  });

  it('serves one client at a time, first come first served, with up to 3 more waiting', () => {
    const w = reef([...spawnMany('cleaner-wrasse', 1), ...spawnMany('yellow-tang', 12)]);
    const c = w.behaviour.cleaning;
    const joined = new Array<number>(w.count).fill(-1);
    let served = 0;
    let fullQueue = 0;
    let overtaken = 0;
    let previous = -1;
    for (let t = 0; t < seconds(900); t++) {
      w.step();
      const now = posing(w);
      expect(now.length).toBeLessThanOrEqual(1);
      const s = at(c.serving, 0);
      expect(s).toBe(now[0] ?? -1);
      let waiting = 0;
      for (let i = 1; i < w.count; i++) {
        const phase = at(c.phase, i);
        if (phase === VisitPhase.None) joined[i] = -1;
        else if (at(joined, i) < 0) joined[i] = w.tick * w.count + i;
        if (phase === VisitPhase.Queued) waiting++;
      }
      expect(c.queueLength(0)).toBe(waiting);
      expect(waiting).toBeLessThanOrEqual(CLEANING.maxQueue);
      if (s >= 0 && waiting === CLEANING.maxQueue) fullQueue++;
      if (s >= 0 && s !== previous) {
        served++;
        for (let i = 1; i < w.count; i++) {
          if (at(c.phase, i) === VisitPhase.Queued && at(joined, i) < at(joined, s)) overtaken++;
        }
      }
      previous = s;
      let poses = 0;
      let cleans = 0;
      for (let i = 0; i < w.count; i++) {
        if (at(w.state, i) === FishState.Pose) poses++;
        if (at(w.state, i) === FishState.Clean) cleans++;
      }
      expect(poses).toBeLessThanOrEqual(1);
      expect(cleans).toBeLessThanOrEqual(1);
    }
    expect(served).toBeGreaterThan(10);
    expect(overtaken).toBe(0);
    expect(fullQueue).toBeGreaterThan(0);
  });

  it('a client gives up after waiting 60 s in the queue, or 20 s failing to reach its spot', () => {
    const w = reef([...spawnMany('cleaner-wrasse', 1), ...spawnMany('yellow-tang', 12)]);
    const c = w.behaviour.cleaning;
    const waited = new Array<number>(w.count).fill(0);
    const approached = new Array<number>(w.count).fill(0);
    let gaveUp = 0;
    let longest = 0;
    for (let t = 0; t < seconds(900); t++) {
      w.step();
      for (let i = 1; i < w.count; i++) {
        const phase = at(c.phase, i);
        if (phase === VisitPhase.Queued) {
          waited[i] = at(waited, i) + 1;
          longest = Math.max(longest, at(waited, i));
          continue;
        }
        if (phase === VisitPhase.None && at(waited, i) >= seconds(CLEANING.giveUpS) - 1) gaveUp++;
        waited[i] = 0;
        approached[i] =
          phase === VisitPhase.Posing && at(c.arrived, i) === 0 ? at(approached, i) + 1 : 0;
        expect(at(approached, i)).toBeLessThanOrEqual(seconds(CLEANING.approachGiveUpS) + 1);
      }
    }
    // The tick it joins counts too.
    expect(longest).toBeLessThanOrEqual(seconds(CLEANING.giveUpS) + 1);
    expect(gaveUp).toBeGreaterThan(0);
  });

  it('poses still beside the station while the wrasse darts about its body', () => {
    const w = reef(community());
    const c = w.behaviour.cleaning;
    const s = untilPosed(w);
    let held = 0;
    let cleaning = 0;
    let near = 0;
    const ls = at(w.bodyLength, s);
    for (let t = 0; t < seconds(5) && at(c.serving, 0) === s; t++) {
      w.step();
      if (at(w.state, s) === FishState.Pose) held++;
      if (at(w.state, 0) === FishState.Clean) cleaning++;
      const d = Math.hypot(
        at(w.position, 0) - at(w.position, s * 3),
        at(w.position, 1) - at(w.position, s * 3 + 1),
        at(w.position, 2) - at(w.position, s * 3 + 2),
      );
      if (d < ls + at(w.bodyLength, 0)) near++;
      expect(at(w.speed, s)).toBeLessThan(0.5 * at(w.cruiseSpeed, s) + 1e-9);
    }
    expect(held).toBeGreaterThan(0);
    expect(cleaning).toBe(held);
    expect(near / held).toBeGreaterThan(0.8);
  });

  it('lets a territorial fish tolerate the wrasse and the clients at its station', () => {
    const w = reef([
      ...spawnMany('cleaner-wrasse', 1),
      ...spawnMany('royal-gramma', 2),
      ...spawnMany('ocellaris-clownfish', 2),
      ...spawnMany('yellow-tang', 2),
    ]);
    const b = w.behaviour;
    for (let t = 0; t < seconds(900); t++) {
      w.step();
      for (let i = 0; i < w.count; i++) {
        const j = at(b.territoryTarget, i);
        if (j < 0) continue;
        expect(j).not.toBe(0);
        expect(at(b.cleaning.phase, i)).toBe(VisitPhase.None);
      }
    }
  });

  it('gives each species one posture, head-down, head-up or level', () => {
    const poses = new Set(SPECIES.map((s) => poseOf(s.id)));
    for (const p of poses) expect([-1, 0, 1]).toContain(p);
    expect(poseOf('yellow-tang')).toBe(poseOf('yellow-tang'));
  });
});

describe('small clients', { timeout: LONG }, () => {
  it('neon tetras mixed in never hold the station: clients are served every 5 minutes', () => {
    let neonsServed = 0;
    let neonsLost = 0;
    let othersLost = 0;
    for (const seed of [1, 2, 3, 4]) {
      const w = reef(mixed(), seed);
      const c = w.behaviour.cleaning;
      const window = seconds(300);
      const approach = new Array<number>(w.count).fill(0);
      let previous = -1;
      let servedInWindow = 0;
      for (let t = 1; t <= seconds(1800); t++) {
        w.step();
        for (let i = 1; i < w.count; i++) {
          const phase = at(c.phase, i);
          if (phase === VisitPhase.None && at(approach, i) >= seconds(CLEANING.approachGiveUpS)) {
            if (w.fishIds[i]?.startsWith('neon-tetra')) neonsLost++;
            else othersLost++;
          }
          approach[i] =
            phase === VisitPhase.Posing && at(c.arrived, i) === 0 ? at(approach, i) + 1 : 0;
          expect(at(approach, i)).toBeLessThanOrEqual(seconds(CLEANING.approachGiveUpS) + 1);
        }
        const s = at(c.serving, 0);
        if (s >= 0 && at(c.arrived, s) === 1 && s !== previous) {
          servedInWindow++;
          if (w.fishIds[s]?.startsWith('neon-tetra')) neonsServed++;
          previous = s;
        }
        if (s < 0) previous = -1;
        if (t % window === 0) {
          expect(servedInWindow, `seed ${seed}, minute ${t / STEP_HZ / 60}`).toBeGreaterThan(0);
          servedInWindow = 0;
        }
      }
    }
    expect(neonsServed).toBeGreaterThan(0);
    expect(neonsLost).toBe(0);
    // A blue tang, twice the wrasse's length, can find no way to its spot past the rock now and
    // then; it gives up rather than hold the station.
    expect(othersLost).toBeGreaterThan(0);
  });

  it('the wrasse steers round a client body, however small, and never enters it', () => {
    let cleaning = 0;
    let pushes = 0;
    for (const seed of [1, 3, 4]) {
      const w = reef(mixed(), seed);
      const c = w.behaviour.cleaning;
      for (let t = 0; t < seconds(1800); t++) {
        w.step();
        const s = at(c.serving, 0);
        if (s < 0 || at(w.state, 0) !== FishState.Clean) continue;
        cleaning++;
        const ls = at(w.bodyLength, s);
        const lc = at(w.bodyLength, 0);
        expect(offSpine(w, s), `seed ${seed}, tick ${w.tick}`).toBeGreaterThanOrEqual(
          BEHAVIOUR.bodyThicknessBodyLengths * (ls + lc) - 1e-9,
        );
      }
      pushes += w.bodyPushes;
    }
    expect(cleaning).toBeGreaterThan(seconds(600));
    // It goes round, not along the body's edge: kept off by force on few of its cleaning steps.
    expect(pushes / cleaning).toBeLessThan(0.03);
  });
});

describe('interruptions', { timeout: LONG }, () => {
  it('a startle ends the visit at once and the wrasse goes back to its station', () => {
    const w = reef(community());
    const c = w.behaviour.cleaning;
    const s = untilPosed(w);
    w.startle({
      position: [at(w.position, s * 3), at(w.position, s * 3 + 1), at(w.position, s * 3 + 2)],
      intensity: 1,
    });
    let ended = -1;
    for (let t = 0; t < seconds(2) && ended < 0; t++) {
      w.step();
      if (at(c.phase, s) === VisitPhase.None) ended = t;
    }
    expect(ended).toBeGreaterThanOrEqual(0);
    expect(at(c.serving, 0)).not.toBe(s);
    for (let t = 0; t < seconds(5); t++) {
      w.step();
      if (at(w.behaviour.startledAt, s) >= 0 && w.behaviour.isStartled(s)) {
        expect(at(c.phase, s)).toBe(VisitPhase.None);
      }
    }
  });

  it('nobody visits at night: the wrasse rests and the station closes', () => {
    const w = reef(community());
    untilPosed(w);
    w.setLight(0);
    const c = w.behaviour.cleaning;
    for (let t = 0; t < seconds(120); t++) w.step();
    for (let t = 0; t < seconds(600); t++) {
      w.step();
      expect(at(c.open, 0)).toBe(0);
      expect(at(c.serving, 0)).toBe(-1);
      for (let i = 0; i < w.count; i++) {
        expect(at(c.phase, i)).toBe(VisitPhase.None);
        expect(at(w.state, i)).not.toBe(FishState.Pose);
        expect(at(w.state, i)).not.toBe(FishState.Clean);
      }
    }
    expect(at(w.behaviour.rest, 0)).toBeGreaterThan(0.9);
    w.setLight(1);
    untilPosed(w);
  });

  it('the wrasse leaving sends its clients away; a client leaving frees the wrasse', () => {
    const w = reef(community());
    const c = w.behaviour.cleaning;
    const s = untilPosed(w);
    const id = w.fishIds[s];
    if (id === undefined) throw new Error('client has an id');
    w.removeFish(id);
    expect(at(c.serving, 0)).toBe(-1);
    w.step();
    untilPosed(w);
    w.removeFish('cleaner-wrasse-0');
    for (let i = 0; i < w.count; i++) {
      expect(at(c.phase, i)).toBe(VisitPhase.None);
      expect(at(c.cleanerOf, i)).toBe(-1);
    }
    for (let t = 0; t < seconds(60); t++) {
      w.step();
      for (let i = 0; i < w.count; i++) expect(at(c.phase, i)).toBe(VisitPhase.None);
    }
  });
});

describe('edge cases', { timeout: LONG }, () => {
  it('a wrasse alone holds its station and serves nobody', () => {
    const w = reef(spawnMany('cleaner-wrasse', 1));
    const c = w.behaviour.cleaning;
    let near = 0;
    const steps = seconds(300);
    for (let t = 0; t < steps; t++) {
      w.step();
      expect(at(c.serving, 0)).toBe(-1);
      const [x, y, z] = station(w, 0);
      const d = Math.hypot(at(w.position, 0) - x, at(w.position, 1) - y, at(w.position, 2) - z);
      if (d < 2 * at(w.bodyLength, 0)) near++;
    }
    expect(near / steps).toBeGreaterThan(0.8);
  });

  it('a tank without a cleaner never schedules a visit', () => {
    const w = reef(community().filter((f) => f.species !== 'cleaner-wrasse'));
    for (let t = 0; t < seconds(600); t++) {
      w.step();
      for (let i = 0; i < w.count; i++) {
        expect(at(w.behaviour.cleaning.phase, i)).toBe(VisitPhase.None);
        expect(at(w.state, i)).not.toBe(FishState.Pose);
      }
    }
  });

  it('runs the same trajectory for the same seed', () => {
    const run = (): Float64Array => {
      const w = reef(community());
      for (let t = 0; t < seconds(300); t++) w.step();
      return w.position.slice();
    };
    expect(run()).toEqual(run());
  });

  it('thirty clients and two wrasse: queues capped, one client each, nothing in the rock', () => {
    const w = reef([
      ...spawnMany('cleaner-wrasse', 2),
      ...spawnMany('neon-tetra', 12),
      ...spawnMany('yellow-tang', 6),
      ...spawnMany('ocellaris-clownfish', 6),
      ...spawnMany('royal-gramma', 6),
    ]);
    const c = w.behaviour.cleaning;
    let worst = Infinity;
    const served = new Set<number>();
    const steps = 10_000;
    for (let t = 0; t < steps; t++) {
      w.step();
      for (const k of [0, 1]) {
        expect(c.queueLength(k)).toBeLessThanOrEqual(CLEANING.maxQueue);
        const s = at(c.serving, k);
        if (s >= 0) {
          expect(at(c.cleanerOf, s)).toBe(k);
          served.add(s);
        }
      }
      expect(posing(w).length).toBeLessThanOrEqual(2);
      for (let i = 0; i < w.count; i++) worst = Math.min(worst, w.bodyClearance(i));
    }
    expect(served.size).toBeGreaterThan(5);
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
    expect(w.contacts / (w.count * steps)).toBeLessThan(1e-3);
  });
});
