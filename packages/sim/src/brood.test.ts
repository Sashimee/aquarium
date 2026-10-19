import { describe, expect, it } from 'vitest';
import type { Collider } from '@aquarium/shared';
import { BROOD, NestPhase, StageCode, type SimBrood } from './brood.ts';
import type { Point3 } from './decor.ts';
import {
  angelfish,
  ARCHETYPES,
  cherryShrimp,
  clownfish,
  guppy,
  REEF_ANCHORS,
  REEF_DECOR,
  REEF_TANK,
  SHOW_DECOR,
  SHOW_TANK,
} from './fixtures.ts';
import { FishState, SNAPSHOT_STRIDE, SnapshotField } from './snapshot.ts';
import { toSimSpecies } from './species.ts';
import { STEP_HZ, World, type FishSpawn } from './world.ts';

const LONG = 300_000;
const NONE: SimBrood = { clutches: [], gravid: [] };
const SPECIES = [...ARCHETYPES, guppy, cherryShrimp];
const CLOWN_LENGTH = toSimSpecies(clownfish).bodyLength;
const FRY_LENGTH = 0.007;
const n3 = new Float64Array(3);

function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range`);
  return v;
}

function seconds(s: number): number {
  return Math.round(s * STEP_HZ);
}

function reef(fish: FishSpawn[], seed = 3): World {
  return new World({
    seed,
    tank: REEF_TANK,
    species: SPECIES,
    decor: REEF_DECOR,
    anchors: REEF_ANCHORS,
    fish,
  });
}

function show(fish: FishSpawn[], seed = 4, decor = SHOW_DECOR): World {
  return new World({ seed, tank: SHOW_TANK, species: SPECIES, decor, fish });
}

function clownPair(seed = 3, sexed = true): World {
  return reef(
    [
      { id: 'm', species: clownfish.id, ...(sexed ? { sex: 'male' as const } : {}) },
      {
        id: 'f',
        species: clownfish.id,
        ...(sexed ? { sex: 'female' as const } : { bodyLengthM: 1.2 * CLOWN_LENGTH }),
      },
    ],
    seed,
  );
}

function distance(w: World, i: number, p: Point3): number {
  return Math.hypot(
    at(w.position, i * 3) - p[0],
    at(w.position, i * 3 + 1) - p[1],
    at(w.position, i * 3 + 2) - p[2],
  );
}

function worstClearance(w: World): number {
  let worst = Infinity;
  for (let i = 0; i < w.count; i++) worst = Math.min(worst, w.bodyClearance(i));
  return worst;
}

function snapshotField(w: World, i: number, field: number): number {
  const data = new Float32Array(w.count * SNAPSHOT_STRIDE);
  w.writeSnapshot(data);
  return at(data, i * SNAPSHOT_STRIDE + field);
}

/** A clownfish pair settled at its anemone with a clutch laid beside it. */
function tendedClutch(seed = 3, sexed = true): { w: World; site: Point3 } {
  const w = clownPair(seed, sexed);
  for (let t = 0; t < seconds(10); t++) w.step();
  const site = w.nestSite(['m', 'f']);
  if (site === null) throw new Error('no nest site beside the anemone');
  w.setBrood({ clutches: [{ id: 'c1', parents: ['m', 'f'], position: site }], gravid: [] });
  return { w, site };
}

/** Share of `steps` each fish spends with its snout within one body length of the eggs. */
function nestShares(w: World, site: Point3, steps: number): number[] {
  const near = new Array<number>(w.count).fill(0);
  for (let t = 0; t < steps; t++) {
    w.step();
    for (let i = 0; i < w.count; i++) {
      if (distance(w, i, site) < (1 + FEEDING_MOUTH) * at(w.bodyLength, i)) {
        near[i] = (near[i] ?? 0) + 1;
      }
    }
  }
  return near.map((v) => v / steps);
}

/** A fish's snout sits half a length ahead of its centre, so "at the eggs" is measured from it. */
const FEEDING_MOUTH = 0.5;

describe('clownfish egg tending', { timeout: LONG }, () => {
  it('lays the clutch on hard rock beside the anemone, drawing no RNG', () => {
    const w = clownPair();
    const twin = clownPair();
    for (let t = 0; t < seconds(10); t++) {
      w.step();
      twin.step();
    }
    const site = w.nestSite(['m', 'f']);
    expect(site).not.toBeNull();
    if (site === null) return;
    expect(w.nestSite(['f', 'm'])).toEqual(site);
    expect(Math.abs(w.substrateSdf.sample(...site, n3))).toBeLessThanOrEqual(BROOD.nestSurfaceM);
    const rock = w.decorSdf;
    expect(rock).not.toBeNull();
    expect(rock?.sample(...site, n3)).toBeLessThanOrEqual(BROOD.nestSurfaceM);
    const anemone = REEF_ANCHORS.find((a) => a.kind === 'anemone');
    if (anemone === undefined) throw new Error('reef fixture lost its anemone');
    const reach = anemone.radius + (2 + BROOD.nestRockPreferenceBodyLengths) * CLOWN_LENGTH;
    expect(Math.hypot(...site.map((v, k) => v - (anemone.position[k] ?? 0)))).toBeLessThan(reach);
    for (let t = 0; t < seconds(5); t++) {
      w.step();
      twin.step();
    }
    expect(Array.from(w.position)).toEqual(Array.from(twin.position));
  });

  it('the father tends more than the mother, fanning and mouthing at the eggs', () => {
    const { w, site } = tendedClutch();
    const phases = new Set<number>();
    let tend = 0;
    let maxFan = 0;
    let worst = Infinity;
    const steps = seconds(1200);
    const near = [0, 0];
    for (let t = 0; t < steps; t++) {
      w.step();
      for (let i = 0; i < 2; i++) {
        phases.add(at(w.behaviour.brood.nestPhase, i));
        if (distance(w, i, site) < (1 + FEEDING_MOUTH) * CLOWN_LENGTH) {
          near[i] = (near[i] ?? 0) + 1;
        }
        if (at(w.state, i) === FishState.Tend) tend++;
      }
      if (t % 10 === 0) maxFan = Math.max(maxFan, snapshotField(w, 0, SnapshotField.Fan));
      worst = Math.min(worst, worstClearance(w));
    }
    const [male, female] = near.map((v) => v / steps) as [number, number];
    // Green & McCormick 2005: fathers 40–70 % of the time, mothers 20–30 %.
    expect(male).toBeGreaterThan(0.4);
    expect(male).toBeLessThan(0.75);
    expect(female).toBeGreaterThan(0.1);
    expect(female).toBeLessThan(0.4);
    expect(male).toBeGreaterThan(female);
    expect(tend).toBeGreaterThan(0);
    expect(phases).toEqual(new Set([NestPhase.Away, NestPhase.Fan, NestPhase.Mouth]));
    expect(maxFan).toBeGreaterThan(0.9);
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
  });

  it('keeps tending through the night, both parents more than by day', () => {
    const { w, site } = tendedClutch();
    w.setLight(0);
    for (let t = 0; t < seconds(180); t++) w.step();
    expect(at(w.behaviour.rest, 0)).toBeGreaterThan(0.99);
    const { brood } = w.behaviour;
    expect(brood.nestShare(0, 1)).toBeGreaterThan(brood.nestShare(0, 0));
    expect(brood.nestShare(1, 1)).toBeGreaterThan(brood.nestShare(1, 0));
    let tend = 0;
    let worst = Infinity;
    const steps = seconds(1200);
    const near = [0, 0];
    for (let t = 0; t < steps; t++) {
      w.step();
      for (let i = 0; i < 2; i++) {
        if (distance(w, i, site) < (1 + FEEDING_MOUTH) * CLOWN_LENGTH) {
          near[i] = (near[i] ?? 0) + 1;
        }
        if (at(w.state, i) === FishState.Tend) tend++;
      }
      worst = Math.min(worst, worstClearance(w));
    }
    const [male, female] = near.map((v) => v / steps) as [number, number];
    // Green & McCormick 2005: fathers tend most late at night; Pacaro et al. 2023: mothers
    // tend far more at night than by day, fathers still the most.
    expect(male).toBeGreaterThan(0.55);
    expect(male).toBeLessThan(0.9);
    expect(female).toBeGreaterThan(0.2);
    expect(male).toBeGreaterThan(female);
    expect(tend).toBeGreaterThan(0);
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
  });

  it('an unsexed pair leaves most of the care to the smaller fish, the male', () => {
    const { w, site } = tendedClutch(5, false);
    const [small, large] = nestShares(w, site, seconds(900)) as [number, number];
    expect(small).toBeGreaterThan(large);
  });

  it('is deterministic with a clutch being tended', () => {
    const a = tendedClutch(9).w;
    const b = tendedClutch(9).w;
    for (let t = 0; t < seconds(120); t++) {
      a.step();
      b.step();
    }
    expect(Array.from(a.position)).toEqual(Array.from(b.position));
    expect(Array.from(a.behaviour.brood.fan)).toEqual(Array.from(b.behaviour.brood.fan));
  });

  it('with no eggs nothing changes: an empty brood draws no RNG and moves no fish', () => {
    const a = clownPair(11);
    const b = clownPair(11);
    b.setBrood(NONE);
    for (let t = 0; t < seconds(60); t++) {
      a.step();
      b.step();
    }
    expect(Array.from(a.position)).toEqual(Array.from(b.position));
    expect(Array.from(b.behaviour.brood.nestPhase)).toEqual([0, 0]);
    expect(b.brood()).toEqual(NONE);
  });

  it('stops tending and folds the fins once the clutch is gone', () => {
    const { w } = tendedClutch();
    for (let t = 0; t < seconds(120); t++) w.step();
    w.setBrood(NONE);
    for (let t = 0; t < seconds(5); t++) w.step();
    for (let t = 0; t < seconds(60); t++) {
      w.step();
      for (let i = 0; i < 2; i++) {
        expect(at(w.state, i)).not.toBe(FishState.Tend);
        expect(at(w.behaviour.brood.nestPhase, i)).toBe(NestPhase.None);
        expect(snapshotField(w, i, SnapshotField.Fan)).toBe(0);
      }
    }
  });

  it('a widowed parent keeps tending, and a clutch with no parent left is dropped', () => {
    const { w, site } = tendedClutch();
    for (let t = 0; t < seconds(60); t++) w.step();
    w.removeFish('m');
    expect(w.brood().clutches).toEqual([{ id: 'c1', parents: ['f'], position: site }]);
    expect(at(w.behaviour.brood.clutchOf, 0)).toBe(0);
    const [female] = nestShares(w, site, seconds(600)) as [number];
    expect(female).toBeGreaterThan(0.1);
    w.removeFish('f');
    expect(w.brood()).toEqual(NONE);
    w.setBrood(w.brood());
    for (let t = 0; t < seconds(5); t++) w.step();
    expect(w.count).toBe(0);
  });

  it('once both parents die no fish tends the clutch', () => {
    const w = reef([
      { id: 'm', species: clownfish.id, sex: 'male' },
      { id: 'f', species: clownfish.id, sex: 'female' },
      { id: 'tang', species: 'yellow-tang' },
    ]);
    const site = w.nestSite(['m', 'f']);
    if (site === null) throw new Error('no nest site');
    w.setBrood({ clutches: [{ id: 'c1', parents: ['m', 'f'], position: site }], gravid: [] });
    w.removeFish('f');
    w.removeFish('m');
    for (let t = 0; t < seconds(10); t++) w.step();
    expect(at(w.behaviour.brood.clutchOf, 0)).toBe(-1);
    expect(at(w.behaviour.brood.nestPhase, 0)).toBe(NestPhase.None);
  });

  it('refuses malformed brood input without changing anything', () => {
    const w = reef([
      { id: 'm', species: clownfish.id },
      { id: 'f', species: clownfish.id },
      { id: 'fry', species: clownfish.id, stage: 'fry', bodyLengthM: FRY_LENGTH },
      { id: 'shrimp', species: cherryShrimp.id },
      { id: 'boy', species: clownfish.id, sex: 'male' },
    ]);
    const site = w.nestSite(['m', 'f']);
    if (site === null) throw new Error('no nest site');
    const clutch = { id: 'c', parents: ['m', 'f'], position: site };
    const midWater: Point3 = [0, 0.3, 0];
    expect(w.substrateSdf.sample(...midWater, n3)).toBeGreaterThan(0.05);
    w.setBrood({ clutches: [clutch], gravid: [] });
    const before = w.brood();
    const bad: [SimBrood, RegExp][] = [
      [{ clutches: [{ ...clutch, parents: ['ghost'] }], gravid: [] }, /not in the tank/],
      [{ clutches: [{ ...clutch, parents: [] }], gravid: [] }, /at least one parent/],
      [{ clutches: [{ ...clutch, parents: ['fry'] }], gravid: [] }, /not an adult/],
      [{ clutches: [{ ...clutch, parents: ['shrimp'] }], gravid: [] }, /walker/],
      [{ clutches: [clutch, { ...clutch, id: 'd' }], gravid: [] }, /parent of two clutches/],
      [{ clutches: [{ ...clutch, parents: ['m', 'f', 'm'] }], gravid: [] }, /"m" is listed twice/],
      [{ clutches: [{ ...clutch, position: midWater }], gravid: [] }, /off the nearest surface/],
      [{ clutches: [], gravid: [{ fishId: 'boy', term: 0.5 }] }, /is male/],
      [{ clutches: [clutch, clutch], gravid: [] }, /repeats/],
      [{ clutches: [{ ...clutch, position: [5, 0.1, 0] }], gravid: [] }, /outside the tank/],
      [{ clutches: [{ ...clutch, position: [0, Number.NaN, 0] }], gravid: [] }, /finite/],
      [{ clutches: [], gravid: [{ fishId: 'f', term: 1.5 }] }, /term within 0 to 1/],
      [
        {
          clutches: [],
          gravid: [
            { fishId: 'f', term: 0.5 },
            { fishId: 'f', term: 0.5 },
          ],
        },
        /gravid twice/,
      ],
    ];
    for (const [input, message] of bad) {
      expect(() => w.setBrood(input)).toThrow(message);
      expect(w.brood()).toEqual(before);
    }
    expect(() => w.setStage('m', 'fry')).toThrow(/must stay adult/);
    expect(() => w.nestSite([])).toThrow(/at least one parent/);
    expect(() => w.nestSite(['ghost'])).toThrow(/no fish "ghost"/);
  });
});

/** A guppy female with four males, an angelfish and the show tank's plants. */
function guppyTank(seed = 4, decor = SHOW_DECOR): World {
  return show(
    [
      { id: 'mother', species: guppy.id, sex: 'female' },
      ...Array.from({ length: 4 }, (_, k) => ({
        id: `male-${k}`,
        species: guppy.id,
        sex: 'male' as const,
      })),
      { id: 'angel', species: angelfish.id },
    ],
    seed,
    decor,
  );
}

function plantDistance(w: World, i: number): number {
  const plants = w.plantSdf;
  if (plants === null) throw new Error('tank has no plants');
  return plants.sample(
    at(w.position, i * 3),
    at(w.position, i * 3 + 1),
    at(w.position, i * 3 + 2),
    n3,
  );
}

function dropFry(w: World, count: number): string[] {
  const mother = w.fishIds.indexOf('mother');
  const p: Point3 = [
    at(w.position, mother * 3),
    at(w.position, mother * 3 + 1),
    at(w.position, mother * 3 + 2),
  ];
  w.setBrood(NONE);
  const ids = Array.from({ length: count }, (_, k) => `fry-${k}`);
  ids.forEach((id, k) =>
    w.addFish(
      { id, species: guppy.id, stage: 'fry', bodyLengthM: FRY_LENGTH },
      { position: p, heading: k },
    ),
  );
  return ids;
}

describe('livebearer pregnancy and the drop', { timeout: LONG }, () => {
  it('a pregnant female cruises slower as her term advances', () => {
    const lone = (term: number): number => {
      const w = show([{ id: 'mother', species: guppy.id, sex: 'female' }], 6, []);
      if (term > 0) w.setBrood({ clutches: [], gravid: [{ fishId: 'mother', term }] });
      let sum = 0;
      const steps = seconds(300);
      for (let t = 0; t < steps; t++) {
        w.step();
        sum += at(w.speed, 0);
      }
      return sum / steps;
    };
    const open = lone(0);
    const late = lone(0.8);
    expect(late).toBeLessThan(open * (1 - 0.5 * BROOD.gravidSpeedLoss * 0.8));
  });

  it('near term she leaves the shoal and keeps to the plants', () => {
    const w = guppyTank();
    for (let t = 0; t < seconds(10); t++) w.step();
    w.setBrood({ clutches: [], gravid: [{ fishId: 'mother', term: 0.95 }] });
    for (let t = 0; t < seconds(30); t++) w.step();
    let sheltered = 0;
    let byPlants = 0;
    const steps = seconds(120);
    for (let t = 0; t < steps; t++) {
      w.step();
      if (at(w.state, 0) === FishState.Shelter) sheltered++;
      if (plantDistance(w, 0) < 0.05) byPlants++;
    }
    expect(sheltered / steps).toBeGreaterThan(0.7);
    expect(byPlants / steps).toBeGreaterThan(0.7);
  });

  it('dropped fry hide by the plants, school only with fry and keep clear of big fish', () => {
    const w = guppyTank();
    for (let t = 0; t < seconds(10); t++) w.step();
    w.setBrood({ clutches: [], gravid: [{ fishId: 'mother', term: 0.95 }] });
    for (let t = 0; t < seconds(60); t++) w.step();
    const ids = dropFry(w, 6);
    const fry = ids.map((id) => w.fishIds.indexOf(id));
    const angel = w.fishIds.indexOf('angel');
    for (const i of fry) {
      expect(at(w.behaviour.brood.gravid, i)).toBe(0);
      expect(at(w.stage, i)).toBe(StageCode.Fry);
      expect(w.behaviour.brood.hides(i)).toBe(true);
    }
    expect(w.behaviour.brood.hides(w.fishIds.indexOf('mother'))).toBe(false);
    let byPlants = 0;
    let samples = 0;
    let nearestAngel = Infinity;
    let worst = Infinity;
    for (let t = 0; t < seconds(300); t++) {
      w.step();
      worst = Math.min(worst, worstClearance(w));
      if (t < seconds(30)) continue;
      for (const i of fry) {
        if (plantDistance(w, i) < 0.03) byPlants++;
        samples++;
        nearestAngel = Math.min(
          nearestAngel,
          distance(w, i, [
            at(w.position, angel * 3),
            at(w.position, angel * 3 + 1),
            at(w.position, angel * 3 + 2),
          ]),
        );
      }
    }
    expect(byPlants / samples).toBeGreaterThan(0.85);
    expect(nearestAngel).toBeGreaterThan(0.5 * at(w.bodyLength, angel));
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
  });

  it('in a tank with no cover, fry hide against the glass or sand without touching it', () => {
    const w = guppyTank(7, []);
    expect(w.plantSdf).toBeNull();
    expect(w.decorSdf).toBeNull();
    const fry = dropFry(w, 4).map((id) => w.fishIds.indexOf(id));
    let atSurface = 0;
    let samples = 0;
    let worst = Infinity;
    for (let t = 0; t < seconds(240); t++) {
      w.step();
      worst = Math.min(worst, worstClearance(w));
      if (t < seconds(30)) continue;
      for (const i of fry) {
        const d = w.sceneSdf.sample(
          at(w.position, i * 3),
          at(w.position, i * 3 + 1),
          at(w.position, i * 3 + 2),
          n3,
        );
        if (d < 4 * FRY_LENGTH) atSurface++;
        samples++;
      }
    }
    expect(atSurface / samples).toBeGreaterThan(0.6);
    expect(worst).toBeGreaterThanOrEqual(-1e-9);
  });

  it('a fry whose hiding spot the decor moves over picks a new one', () => {
    const w = guppyTank();
    const [id] = dropFry(w, 1);
    if (id === undefined) throw new Error('no fry dropped');
    const i = w.fishIds.indexOf(id);
    for (let t = 0; t < seconds(5); t++) w.step();
    const { cover } = w.behaviour.brood;
    const spot: Point3 = [at(cover, i * 3), at(cover, i * 3 + 1), at(cover, i * 3 + 2)];
    const rock: Collider = {
      id: 'new-rock',
      hard: true,
      kind: 'sphere',
      center: [...spot],
      radius: 0.02,
    };
    w.setDecor([...SHOW_DECOR, rock]);
    expect(w.sceneSdf.sample(...spot, n3)).toBeLessThan(0);
    w.step();
    const moved: Point3 = [at(cover, i * 3), at(cover, i * 3 + 1), at(cover, i * 3 + 2)];
    expect(moved).not.toEqual(spot);
    expect(w.sceneSdf.sample(...moved, n3)).toBeGreaterThanOrEqual(at(w.radius, i));
  });

  it('growing up ends the hiding and brings the young into the adult school', () => {
    const schooling = (stage: 'juvenile' | 'adult', mates: number): number => {
      const w = guppyTank(8);
      const ids = dropFry(w, 1 + mates);
      for (const id of ids) w.setStage(id, stage);
      const i = w.fishIds.indexOf(ids[0] ?? '');
      expect(w.behaviour.brood.hides(i)).toBe(false);
      expect(w.behaviour.brood.young(i)).toBe(stage === 'juvenile');
      let schooled = 0;
      for (let t = 0; t < seconds(60); t++) {
        w.step();
        if (at(w.state, i) === FishState.School) schooled++;
      }
      return schooled;
    };
    expect(schooling('juvenile', 0)).toBe(0);
    expect(schooling('juvenile', 2)).toBeGreaterThan(0);
    expect(schooling('adult', 0)).toBeGreaterThan(0);
    const w = guppyTank();
    const [id] = dropFry(w, 1);
    expect(() => w.setStage(id ?? '', 'egg' as never)).toThrow(/fry, juvenile or adult/);
  });

  it('is deterministic through pregnancy and the drop', () => {
    const run = (): number[] => {
      const w = guppyTank(12);
      w.setBrood({ clutches: [], gravid: [{ fishId: 'mother', term: 0.9 }] });
      for (let t = 0; t < seconds(30); t++) w.step();
      dropFry(w, 5);
      for (let t = 0; t < seconds(60); t++) w.step();
      return Array.from(w.position);
    };
    expect(run()).toEqual(run());
  });
});
