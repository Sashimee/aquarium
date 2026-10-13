import { describe, expect, it } from 'vitest';
import { BEHAVIOUR, type Anchor } from './behaviour.ts';
import {
  ARCHETYPES,
  angelfish,
  betta,
  bronzeCorydoras,
  clownfish,
  neonTetra,
  otocinclus,
  REEF_ANCHORS,
  REEF_DECOR,
  REEF_TANK,
  royalGramma,
  SHOW_DECOR,
  SHOW_TANK,
  spawnMany,
  yellowTang,
} from './fixtures.ts';
import { FishState } from './snapshot.ts';
import { toSimSpecies, type SpeciesInput } from './species.ts';
import { STEP_DT, World, type FishSpawn } from './world.ts';

const LONG = 60_000;
const n3 = new Float64Array(3);

function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range`);
  return v;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? NaN;
}

function showTank(fish: FishSpawn[], seed = 1, decor = true): World {
  return new World({
    seed,
    tank: SHOW_TANK,
    species: ARCHETYPES,
    decor: decor ? SHOW_DECOR : [],
    fish,
  });
}

function reefTank(fish: FishSpawn[], seed = 1): World {
  return new World({
    seed,
    tank: REEF_TANK,
    species: ARCHETYPES,
    decor: REEF_DECOR,
    anchors: REEF_ANCHORS,
    fish,
  });
}

function distanceTo(w: World, i: number, p: readonly number[]): number {
  return Math.hypot(
    at(w.position, i * 3) - (p[0] ?? 0),
    at(w.position, i * 3 + 1) - (p[1] ?? 0),
    at(w.position, i * 3 + 2) - (p[2] ?? 0),
  );
}

function anchorOf(id: string): (typeof REEF_ANCHORS)[number] {
  const a = REEF_ANCHORS.find((x) => x.id === id);
  if (a === undefined) throw new Error(`no anchor ${id}`);
  return a;
}

describe('burst-and-coast', { timeout: LONG }, () => {
  it('kicks every 0.3–1 s, as tetras do (Calovi et al. 2018: ~0.5 s)', () => {
    const w = showTank(spawnMany(neonTetra.id, 20), 3, false);
    const lastKick = new Float64Array(w.count).fill(-1);
    const wasCoasting = new Uint8Array(w.count);
    const intervals: number[] = [];
    for (let t = 0; t < 3000; t++) {
      w.step();
      for (let i = 0; i < w.count; i++) {
        const coasting = at(w.thrust, i) === 0 ? 1 : 0;
        if (wasCoasting[i] === 1 && coasting === 0) {
          if (at(lastKick, i) >= 0 && t > 300) intervals.push((t - at(lastKick, i)) * STEP_DT);
          lastKick[i] = t;
        }
        wasCoasting[i] = coasting;
      }
    }
    expect(intervals.length).toBeGreaterThan(500);
    const m = median(intervals);
    expect(m).toBeGreaterThanOrEqual(0.3);
    expect(m).toBeLessThanOrEqual(1);
  });
});

describe('labriform hovering', { timeout: LONG }, () => {
  it('angelfish hold a station near decor at a fraction of cruise speed', () => {
    const w = showTank(spawnMany(angelfish.id, 4), 2);
    const cruise = toSimSpecies(angelfish).cruiseSpeed;
    let station = 0;
    let samples = 0;
    let speed = 0;
    for (let t = 0; t < 6000; t++) {
      w.step();
      if (t < 900) continue;
      for (let i = 0; i < w.count; i++) {
        if (at(w.state, i) === FishState.Station) station++;
        speed += at(w.speed, i);
        samples++;
      }
    }
    expect(station / samples).toBeGreaterThan(0.5);
    expect(speed / samples).toBeLessThan(0.6 * cruise);
  });
});

describe('corydoras', { timeout: LONG }, () => {
  it('forage on the bottom and dart to the surface to gulp air', () => {
    const w = showTank(spawnMany(bronzeCorydoras.id, 6), 4);
    const h = SHOW_TANK.height;
    const length = toSimSpecies(bronzeCorydoras).bodyLength;
    let bottom = 0;
    let samples = 0;
    let gulps = 0;
    let reachedSurface = 0;
    const inGulp = new Uint8Array(w.count);
    const peak = new Float64Array(w.count);
    const steps = 18_000;
    for (let t = 0; t < steps; t++) {
      w.step();
      for (let i = 0; i < w.count; i++) {
        const y = at(w.position, i * 3 + 1);
        const gulping = at(w.state, i) === FishState.Gulp;
        if (gulping && inGulp[i] === 0) {
          gulps++;
          peak[i] = y;
        }
        if (gulping) peak[i] = Math.max(at(peak, i), y);
        if (!gulping && inGulp[i] === 1 && at(peak, i) >= h - length) reachedSurface++;
        inGulp[i] = gulping ? 1 : 0;
        if (!gulping) {
          samples++;
          if (y < 0.15 * h) bottom++;
        }
      }
    }
    expect(bottom / samples).toBeGreaterThan(0.9);
    // Kramer & McClure 1980: 1–45 breaths per hour; the model averages BEHAVIOUR.gulpsPerHour.
    const perHour = gulps / ((w.count * steps * STEP_DT) / 3600);
    expect(perHour).toBeGreaterThan(1);
    expect(perHour).toBeLessThan(45);
    expect(reachedSurface).toBeGreaterThanOrEqual(Math.max(1, gulps - w.count));
  });
});

describe('glass grazing', { timeout: LONG }, () => {
  it('otocinclus attach belly-first to glass and decor without penetrating it', () => {
    const w = showTank(spawnMany(otocinclus.id, 6), 5);
    const length = toSimSpecies(otocinclus).bodyLength;
    let attached = 0;
    let samples = 0;
    let worst = Infinity;
    for (let t = 0; t < 6000; t++) {
      w.step();
      for (let i = 0; i < w.count; i++) {
        worst = Math.min(worst, w.bodyClearance(i));
        if (t < 600) continue;
        const d = w.substrateSdf.sample(
          at(w.position, i * 3),
          at(w.position, i * 3 + 1),
          at(w.position, i * 3 + 2),
          n3,
        );
        if (d < 0.5 * length && at(w.state, i) === FishState.Graze) attached++;
        samples++;
      }
    }
    expect(attached / samples).toBeGreaterThan(0.4);
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
  });
});

describe('territoriality', { timeout: LONG }, () => {
  it('a betta flares at a rival male inside its territory', () => {
    const w = showTank(spawnMany(betta.id, 2), 6);
    const length = toSimSpecies(betta).bodyLength;
    let display = 0;
    let near = 0;
    for (let t = 0; t < 6000; t++) {
      w.step();
      for (let i = 0; i < w.count; i++) {
        if (at(w.state, i) !== FishState.Display) continue;
        display++;
        const j = 1 - i;
        const d = distanceTo(w, i, [
          at(w.position, j * 3),
          at(w.position, j * 3 + 1),
          at(w.position, j * 3 + 2),
        ]);
        if (d < (BEHAVIOUR.territoryBodyLengths + 2) * length) near++;
      }
    }
    expect(display).toBeGreaterThan(100);
    expect(near / display).toBeGreaterThan(0.9);
    expect(Array.from(w.behaviour.startledAt)).toEqual([-1, -1]);
  });

  it('a charged rival swims off at a moderate pace instead of fast-starting', () => {
    const w = showTank(spawnMany(betta.id, 2), 6);
    const sp = toSimSpecies(betta);
    const cap = Math.min(sp.maxSpeed, BEHAVIOUR.yieldCruiseFactor * sp.cruiseSpeed);
    const yieldTicks = Math.round(BEHAVIOUR.yieldS / STEP_DT);
    const gaps: number[] = [];
    let yields = 0;
    let fastest = 0;
    const started = new Float64Array(w.count).fill(-1);
    const gapAtStart = new Float64Array(w.count);
    const gap = () => distanceTo(w, 0, [at(w.position, 3), at(w.position, 4), at(w.position, 5)]);
    for (let t = 0; t < 9000; t++) {
      const before = Array.from(w.behaviour.yieldTimer);
      w.step();
      for (let i = 0; i < w.count; i++) {
        const left = at(w.behaviour.yieldTimer, i);
        if (left > at(before, i)) {
          yields++;
          started[i] = t;
          gapAtStart[i] = gap();
        }
        // Speed the fish already had when it was charged takes a moment to bleed off.
        if (left > 0 && left < BEHAVIOUR.yieldS - 0.5) fastest = Math.max(fastest, at(w.speed, i));
        if (at(started, i) >= 0 && t - at(started, i) === yieldTicks) {
          gaps.push(gap() - at(gapAtStart, i));
        }
      }
    }
    expect(yields).toBeGreaterThan(2);
    expect(Array.from(w.behaviour.startledAt)).toEqual([-1, -1]);
    expect(fastest).toBeLessThanOrEqual(cap * 1.05);
    expect(median(gaps)).toBeGreaterThan(0.5 * sp.bodyLength);
  });
});

describe('anchored species', { timeout: LONG }, () => {
  it('rejects anchors a forged or corrupt scene message could carry', () => {
    const w = reefTank(spawnMany(clownfish.id, 2));
    const forged = (value: unknown): Anchor => value as Anchor;
    const base = { id: 'a', kind: 'anemone', position: [0, 0.1, 0], radius: 0.05 };
    expect(() => w.setAnchors([forged({ ...base, id: 3 })])).toThrow(/non-empty string/);
    expect(() => w.setAnchors([forged({ ...base, kind: 'reef' })])).toThrow(
      /anchor "a": kind must be "anemone" or "cave"/,
    );
    expect(() => w.setAnchors([forged({ ...base, position: 'here' })])).toThrow(
      /anchor "a": position must be an \[x, y, z\] array/,
    );
    for (const facing of [
      [0, 0, 0],
      [0, Number.NaN, 1],
      [1, 0],
    ]) {
      expect(() => w.setAnchors([forged({ ...base, kind: 'cave', facing })])).toThrow(
        /anchor "a": facing must be a finite, non-zero/,
      );
    }
    expect(() =>
      w.setAnchors([forged({ ...base, kind: 'cave', facing: [0, 0, 2] })]),
    ).not.toThrow();
  });

  it('clownfish stay leashed to their anemone and host in it', () => {
    const w = reefTank(spawnMany(clownfish.id, 2), 7);
    const anemone = anchorOf('anemone');
    const length = toSimSpecies(clownfish).bodyLength;
    const leash = anemone.radius + (BEHAVIOUR.hostLeashBodyLengths + 1) * length;
    let close = 0;
    let host = 0;
    let samples = 0;
    for (let t = 0; t < 6000; t++) {
      w.step();
      if (t < 300) continue;
      for (let i = 0; i < w.count; i++) {
        if (distanceTo(w, i, anemone.position) < leash) close++;
        if (at(w.state, i) === FishState.Host) host++;
        samples++;
      }
    }
    // Excursions take them a few body lengths out now and then (Fautin 1991).
    expect(close / samples).toBeGreaterThan(0.75);
    expect(host / samples).toBeGreaterThan(0.3);
  });

  it('royal gramma keep to the cave mouth by day and shelter inside at night and when startled', () => {
    const w = reefTank(spawnMany(royalGramma.id, 1), 8);
    const cave = anchorOf('cave');
    const length = toSimSpecies(royalGramma).bodyLength;
    const leash = cave.radius + BEHAVIOUR.caveLeashBodyLengths * length + length;
    let close = 0;
    let day = 0;
    for (let t = 0; t < 3000; t++) {
      w.step();
      if (t < 300) continue;
      if (distanceTo(w, 0, cave.position) < leash) close++;
      day++;
    }
    expect(close / day).toBeGreaterThan(0.8);

    w.startle({ position: [at(w.position, 0), at(w.position, 1), 0.3], intensity: 1 });
    let shelteredAfterStartle = false;
    for (let t = 0; t < 300; t++) {
      w.step();
      if (at(w.state, 0) === FishState.Shelter) shelteredAfterStartle = true;
    }
    expect(at(w.behaviour.startledAt, 0)).toBeGreaterThanOrEqual(0);
    expect(shelteredAfterStartle).toBe(true);

    w.setLight(0);
    let inside = 0;
    let night = 0;
    for (let t = 0; t < 9000; t++) {
      w.step();
      if (t < 4500) continue;
      const s = at(w.state, 0);
      if (
        (s === FishState.Shelter || s === FishState.Rest) &&
        distanceTo(w, 0, cave.position) < cave.radius + length
      ) {
        inside++;
      }
      night++;
    }
    expect(inside / night).toBeGreaterThan(0.6);
  });

  it('yellow tangs graze close to the rock (Montgomery et al. 1989)', () => {
    const w = reefTank(spawnMany(yellowTang.id, 2), 9);
    const length = toSimSpecies(yellowTang).bodyLength;
    let graze = 0;
    let onRock = 0;
    for (let t = 0; t < 9000; t++) {
      w.step();
      for (let i = 0; i < w.count; i++) {
        if (at(w.state, i) !== FishState.Graze) continue;
        graze++;
        const d =
          w.decorSdf?.sample(
            at(w.position, i * 3),
            at(w.position, i * 3 + 1),
            at(w.position, i * 3 + 2),
            n3,
          ) ?? Infinity;
        if (d < length) onRock++;
      }
    }
    expect(graze).toBeGreaterThan(200);
    expect(onRock / graze).toBeGreaterThan(0.8);
  });
});

function schooled(seed: number): World {
  const w = showTank(spawnMany(neonTetra.id, 30), seed, false);
  for (let t = 0; t < 900; t++) w.step();
  return w;
}

/** A tap 5 cm beside fish 0, and the fish close enough to it to count as its school. */
function tapBeside(w: World, intensity: number): { school: number[] } {
  const p = [at(w.position, 0), at(w.position, 1), at(w.position, 2)];
  const school: number[] = [];
  for (let i = 0; i < w.count; i++) if (distanceTo(w, i, p) < 0.25) school.push(i);
  w.startle({ position: [at(p, 0), at(p, 1), at(p, 2) + 0.05], intensity });
  return { school };
}

function startledSince(w: World, tick: number, among?: number[]): number[] {
  const out: number[] = [];
  for (const i of among ?? Array.from({ length: w.count }, (_, k) => k)) {
    if (at(w.behaviour.startledAt, i) >= tick) out.push(i);
  }
  return out;
}

describe('startle cascade', { timeout: LONG }, () => {
  it('spreads through the school a step or two per relay and reaches most fish', () => {
    let responded = 0;
    let total = 0;
    let relayed = 0;
    for (const seed of [1, 2, 3, 4]) {
      const w = schooled(seed);
      const t0 = 900;
      const { school } = tapBeside(w, 1);
      for (let t = 0; t < 60; t++) w.step();
      const ticks = startledSince(w, t0)
        .map((i) => at(w.behaviour.startledAt, i))
        .sort((a, b) => a - b);
      expect(ticks[0]).toBe(t0);
      // Every relayed response follows an earlier one by 1–2 steps (33–67 ms): a Mauthner
      // latency of 5–10 ms (Eaton et al. 1977) plus the neighbour's visual reaction.
      for (let k = 1; k < ticks.length; k++) {
        expect(at(ticks, k) - at(ticks, k - 1)).toBeLessThanOrEqual(2);
      }
      relayed += ticks.filter((t) => t > t0).length;
      responded += startledSince(w, t0, school).length;
      total += school.length;
    }
    expect(relayed).toBeGreaterThan(0);
    // Herbert-Read et al. 2015: 84 ± 16% of a school responds to a startled neighbour.
    expect(responded / total).toBeGreaterThan(0.6);
    expect(responded / total).toBeLessThanOrEqual(1);
  });

  it('travels outward faster than any fish can swim (Treherne & Foster 1981)', () => {
    const w = schooled(5);
    const origin = [at(w.position, 0), at(w.position, 1), at(w.position, 2) + 0.05];
    const start = new Float64Array(w.position);
    tapBeside(w, 1);
    for (let t = 0; t < 60; t++) w.step();
    let reach = 0;
    let when = 0;
    for (const i of startledSince(w, 901)) {
      const d = Math.hypot(
        at(start, i * 3) - at(origin, 0),
        at(start, i * 3 + 1) - at(origin, 1),
        at(start, i * 3 + 2) - at(origin, 2),
      );
      if (d > reach) {
        reach = d;
        when = (at(w.behaviour.startledAt, i) - 900) * STEP_DT;
      }
    }
    expect(when).toBeGreaterThan(0);
    expect(reach / when).toBeGreaterThan(toSimSpecies(neonTetra).maxSpeed);
  });

  it('ignores a second tap during the refractory period', () => {
    const w = schooled(6);
    tapBeside(w, 1);
    for (let t = 0; t < 15; t++) w.step();
    const first = new Float64Array(w.behaviour.startledAt);
    tapBeside(w, 1);
    w.step();
    let checked = 0;
    for (let i = 0; i < w.count; i++) {
      if (at(first, i) < 900) continue;
      expect(at(w.behaviour.startledAt, i)).toBe(at(first, i));
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('habituates to repeated taps', () => {
    const fractions: number[] = [];
    for (const seed of [7, 8, 9]) {
      const w = schooled(seed);
      for (let k = 0; k < 8; k++) {
        const tick = 900 + k * 150;
        const { school } = tapBeside(w, 0.6);
        for (let t = 0; t < 150; t++) w.step();
        const share = startledSince(w, tick, school).length / Math.max(1, school.length);
        fractions[k] = (fractions[k] ?? 0) + share / 3;
      }
    }
    const early = (at(fractions, 0) + at(fractions, 1)) / 2;
    const late = (at(fractions, 6) + at(fractions, 7)) / 2;
    expect(late).toBeLessThan(0.75 * early);
  });
});

describe('day and night', { timeout: LONG }, () => {
  it('fish slow down and rest at night (Reebs 2002)', () => {
    const w = showTank(spawnMany(neonTetra.id, 20), 10, false);
    let day = 0;
    let night = 0;
    let rest = 0;
    let samples = 0;
    for (let t = 0; t < 900; t++) w.step();
    for (let t = 0; t < 900; t++) {
      w.step();
      for (let i = 0; i < w.count; i++) day += at(w.speed, i);
    }
    w.setLight(0);
    for (let t = 0; t < 7200; t++) w.step();
    for (let t = 0; t < 900; t++) {
      w.step();
      for (let i = 0; i < w.count; i++) {
        night += at(w.speed, i);
        if (at(w.behaviour.rest, i) > 0.9) rest++;
        samples++;
      }
    }
    expect(night).toBeLessThan(0.5 * day);
    expect(rest / samples).toBeGreaterThan(0.9);
  });
});

describe('behaviour traits', () => {
  const base = neonTetra;
  const withTraits = (traits: string[], extra: Partial<SpeciesInput['behaviour']> = {}) => ({
    ...base,
    behaviour: {
      ...base.behaviour,
      ...extra,
      traits: traits as SpeciesInput['behaviour']['traits'],
    },
  });

  it('rejects an unknown trait and names the known ones', () => {
    expect(() => toSimSpecies(withTraits(['jumps']))).toThrow(/unknown behaviour trait "jumps"/);
  });

  it('rejects traits that exclude each other', () => {
    expect(() => toSimSpecies(withTraits(['anemone-host', 'cave-dweller']))).toThrow(
      /exclude each other/,
    );
    expect(() => toSimSpecies(withTraits(['glass-grazer', 'rock-grazer']))).toThrow(
      /exclude each other/,
    );
  });

  it('requires a schooling block for a shoal and territoriality for a flare display', () => {
    expect(() => toSimSpecies(withTraits(['shoal'], { schooling: undefined }))).toThrow(
      /needs a behaviour.schooling block/,
    );
    expect(() => toSimSpecies(withTraits(['flare-display'], { territorial: false }))).toThrow(
      /needs territorial: true/,
    );
  });

  it('maps traits to behaviours', () => {
    const s = toSimSpecies(withTraits(['shoal', 'air-gulp', 'glass-grazer']));
    expect(s.shoal).toBe(true);
    expect(s.airGulp).toBe(true);
    expect(s.grazer).toBe('glass');
    expect(s.bellyToSurface).toBe(true);
    expect(toSimSpecies(royalGramma).home).toBe('cave');
    expect(toSimSpecies(clownfish).home).toBe('anemone');
    expect(toSimSpecies(angelfish).home).toBe('station');
  });
});

describe('per-trait parameters', () => {
  const tetra = (
    extra: Partial<SpeciesInput['behaviour']>,
    traits: SpeciesInput['behaviour']['traits'] = [],
  ): SpeciesInput => ({
    ...neonTetra,
    behaviour: { ...neonTetra.behaviour, ...extra, traits },
  });

  it('falls back to the BEHAVIOUR defaults when a species sets no parameters', () => {
    const s = toSimSpecies(betta);
    expect(s.gulpsPerHour).toBe(BEHAVIOUR.gulpsPerHour);
    expect([s.grazeMeanIntervalS, s.grazeMinS, s.grazeMaxS]).toEqual([
      BEHAVIOUR.grazeMeanIntervalS,
      BEHAVIOUR.grazeMinS,
      BEHAVIOUR.grazeMaxS,
    ]);
    expect([s.flareMinS, s.flareMaxS]).toEqual([BEHAVIOUR.flareMinS, BEHAVIOUR.flareMaxS]);
    expect([s.stationRadiusBodyLengths, s.restationMinS, s.restationMaxS]).toEqual([
      BEHAVIOUR.stationRadiusBodyLengths,
      BEHAVIOUR.restationMinS,
      BEHAVIOUR.restationMaxS,
    ]);
    expect(s.shelterAfterStartleS).toBe(BEHAVIOUR.shelterAfterStartleS);
    expect([s.excursionMeanIntervalS, s.hostLeashBodyLengths]).toEqual([
      BEHAVIOUR.excursionMeanIntervalS,
      BEHAVIOUR.hostLeashBodyLengths,
    ]);
  });

  it('reads each parameter object and keeps defaults for the fields it leaves out', () => {
    const tang = toSimSpecies({
      ...yellowTang,
      behaviour: { ...yellowTang.behaviour, grazing: { meanIntervalS: 8, maxS: 3 } },
    });
    expect([tang.grazeMeanIntervalS, tang.grazeMinS, tang.grazeMaxS]).toEqual([
      8,
      BEHAVIOUR.grazeMinS,
      3,
    ]);
    const fish = toSimSpecies({
      ...angelfish,
      behaviour: { ...angelfish.behaviour, station: { radiusBodyLengths: 3, restationMaxS: 90 } },
    });
    expect([fish.stationRadiusBodyLengths, fish.restationMinS, fish.restationMaxS]).toEqual([
      3,
      BEHAVIOUR.restationMinS,
      90,
    ]);
    const clown = toSimSpecies({
      ...clownfish,
      behaviour: { ...clownfish.behaviour, excursion: { meanIntervalS: 40, leashBodyLengths: 2 } },
    });
    expect([clown.excursionMeanIntervalS, clown.hostLeashBodyLengths]).toEqual([40, 2]);
    const gramma = toSimSpecies({
      ...royalGramma,
      behaviour: { ...royalGramma.behaviour, refuge: { afterStartleS: 45 } },
    });
    expect(gramma.shelterAfterStartleS).toBe(45);
    const fighter = toSimSpecies({
      ...betta,
      behaviour: { ...betta.behaviour, flare: { minS: 4, maxS: 9 } },
    });
    expect([fighter.flareMinS, fighter.flareMaxS]).toEqual([4, 9]);
    const cory = toSimSpecies({
      ...bronzeCorydoras,
      behaviour: { ...bronzeCorydoras.behaviour, airGulp: { perHour: 20 } },
    });
    expect(cory.gulpsPerHour).toBe(20);
    const homed = toSimSpecies({
      ...clownfish,
      behaviour: { ...clownfish.behaviour, station: { radiusBodyLengths: 2 } },
    });
    expect(homed.stationRadiusBodyLengths).toBe(2);
    for (const sheltering of [bronzeCorydoras, otocinclus]) {
      const s = toSimSpecies({
        ...sheltering,
        behaviour: {
          ...sheltering.behaviour,
          traits: [...sheltering.behaviour.traits, 'cave-dweller'],
          refuge: { afterStartleS: 10 },
        },
      });
      expect(s.shelterAfterStartleS).toBe(10);
    }
  });

  it('rejects a min/max pair that is out of order once merged with the defaults', () => {
    expect(() =>
      toSimSpecies({
        ...yellowTang,
        behaviour: { ...yellowTang.behaviour, grazing: { meanIntervalS: 20, minS: 50 } },
      }),
    ).toThrow(/species "yellow-tang": behaviour.grazing.minS\/maxS min 50 exceeds max 4/);
    expect(() =>
      toSimSpecies({
        ...angelfish,
        behaviour: { ...angelfish.behaviour, station: { radiusBodyLengths: 1, restationMaxS: 5 } },
      }),
    ).toThrow(/species "angelfish": behaviour.station.restationMinS\/restationMaxS min 20/);
    expect(() =>
      toSimSpecies({ ...betta, behaviour: { ...betta.behaviour, flare: { minS: 6, maxS: 3 } } }),
    ).toThrow(/species "betta": behaviour.flare.minS\/maxS min 6 exceeds max 3/);
  });

  it('rejects a non-positive value', () => {
    expect(() =>
      toSimSpecies({
        ...bronzeCorydoras,
        behaviour: { ...bronzeCorydoras.behaviour, airGulp: { perHour: 0 } },
      }),
    ).toThrow(/behaviour.airGulp.perHour must be a positive number/);
  });

  it('rejects a parameter object the sim would never read', () => {
    expect(() => toSimSpecies(tetra({ airGulp: { perHour: 4 } }))).toThrow(
      /species "neon-tetra": behaviour.airGulp is set but needs trait "air-gulp" and gait "forage"/,
    );
    expect(() => toSimSpecies(tetra({ airGulp: { perHour: 4 } }, ['air-gulp']))).toThrow(
      /behaviour.airGulp is set but needs trait "air-gulp" and gait "forage"/,
    );
    expect(() => toSimSpecies(tetra({ grazing: { meanIntervalS: 10 } }, ['glass-grazer']))).toThrow(
      /behaviour.grazing is set but needs trait "rock-grazer"/,
    );
    expect(() =>
      toSimSpecies({
        ...angelfish,
        behaviour: {
          ...angelfish.behaviour,
          traits: ['rock-grazer'],
          grazing: { meanIntervalS: 5 },
        },
      }),
    ).toThrow(/behaviour.grazing is set but needs trait "rock-grazer" on a species with no home/);
    expect(() => toSimSpecies(tetra({ station: { radiusBodyLengths: 2 } }))).toThrow(
      /behaviour.station is set but needs gait "hover" or an anemone or cave home/,
    );
    expect(() => toSimSpecies(tetra({ refuge: { afterStartleS: 10 } }))).toThrow(
      /needs trait "cave-dweller"/,
    );
    expect(() => toSimSpecies(tetra({ excursion: { meanIntervalS: 10 } }))).toThrow(
      /needs trait "anemone-host"/,
    );
  });

  it('accepts station parameters on an anemone or cave species, which stations without an anchor', () => {
    for (const home of [clownfish, royalGramma]) {
      const s = toSimSpecies({
        ...home,
        behaviour: { ...home.behaviour, station: { radiusBodyLengths: 4, restationMinS: 30 } },
      });
      expect([s.stationRadiusBodyLengths, s.restationMinS]).toEqual([4, 30]);
    }
  });

  it(
    'an anchorless clownfish holds its station to its own station radius',
    { timeout: LONG },
    () => {
      const withRadius = (id: string, radiusBodyLengths: number): SpeciesInput => ({
        ...clownfish,
        id,
        behaviour: {
          ...clownfish.behaviour,
          station: { radiusBodyLengths, restationMinS: 500, restationMaxS: 600 },
        },
      });
      const run = (): number[] => {
        const w = new World({
          seed: 11,
          tank: SHOW_TANK,
          species: [withRadius('clown-tight', 0.5), withRadius('clown-loose', 8)],
          decor: SHOW_DECOR,
          fish: [...spawnMany('clown-tight', 4), ...spawnMany('clown-loose', 4)],
        });
        const station = [0, 0];
        for (let t = 0; t < 3600; t++) {
          w.step();
          if (t < 900) continue;
          for (let i = 0; i < w.count; i++) {
            if (at(w.state, i) !== FishState.Station) continue;
            const k = i < 4 ? 0 : 1;
            station[k] = at(station, k) + 1;
          }
        }
        return station;
      };
      const station = run();
      // 4 fish × 2700 ticks: the 0.5 L radius is mostly overshot, the 8 L one rarely left.
      expect(at(station, 0)).toBeLessThan(0.4 * 10_800);
      expect(at(station, 1)).toBeGreaterThan(0.75 * 10_800);
      expect(run()).toEqual(station);
    },
  );

  it(
    'two air-gulping species with different rates gulp at different rates, reproducibly',
    { timeout: LONG },
    () => {
      const withRate = (id: string, perHour: number): SpeciesInput => ({
        ...bronzeCorydoras,
        id,
        behaviour: { ...bronzeCorydoras.behaviour, airGulp: { perHour } },
      });
      const run = (): number[] => {
        const w = new World({
          seed: 11,
          tank: SHOW_TANK,
          species: [withRate('cory-slow', 2), withRate('cory-fast', 90)],
          decor: SHOW_DECOR,
          fish: [...spawnMany('cory-slow', 6), ...spawnMany('cory-fast', 6)],
        });
        const gulping = new Uint8Array(w.count);
        const gulps = [0, 0];
        for (let t = 0; t < 9000; t++) {
          w.step();
          for (let i = 0; i < w.count; i++) {
            const now = at(w.state, i) === FishState.Gulp ? 1 : 0;
            if (now === 1 && gulping[i] === 0) {
              const k = i < 6 ? 0 : 1;
              gulps[k] = at(gulps, k) + 1;
            }
            gulping[i] = now;
          }
        }
        return gulps;
      };
      const gulps = run();
      // Six fish for five minutes: about 1 gulp expected at 2/h and 45 at 90/h.
      expect(at(gulps, 0)).toBeLessThanOrEqual(5);
      expect(at(gulps, 1)).toBeGreaterThan(20);
      expect(run()).toEqual(gulps);
    },
  );
});
