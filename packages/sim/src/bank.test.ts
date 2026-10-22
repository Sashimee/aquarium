import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { speciesContentSchema, type Collider } from '@aquarium/shared';
import { describe, expect, it } from 'vitest';
import { BANK } from './bank.ts';
import type { Anchor } from './behaviour.ts';
import { ARCHETYPES, SHOW_TANK, spawnMany } from './fixtures.ts';
import { FishState } from './snapshot.ts';
import { toSimSpecies } from './species.ts';
import { WAVE_MAKER } from './waveMaker.ts';
import { STEP_HZ, World, type FishSpawn } from './world.ts';

const dir = join(import.meta.dirname, '../../../content/species');

function content(id: string) {
  const raw: unknown = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'));
  return speciesContentSchema.parse(raw);
}

const BARRED = content('barred-mudskipper');
const BLUE_SPOTTED = content('blue-spotted-mudskipper');

function at(a: ArrayLike<number>, i: number): number {
  const v = a[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range`);
  return v;
}

function seconds(s: number): number {
  return Math.round(s * STEP_HZ);
}

const WATER_TOP = SHOW_TANK.height;
const STUMP_X = 0.3;
const STUMP_Z = 0;
const STUMP_RADIUS = 0.03;
/** A mangrove stump standing out of the water, its rounded top 3 cm above the surface. */
const STUMP: Collider = {
  id: 'stump',
  hard: true,
  kind: 'capsule',
  a: [STUMP_X, 0, STUMP_Z],
  b: [STUMP_X, WATER_TOP, STUMP_Z],
  radius: STUMP_RADIUS,
};
const BANK_AT: Anchor = {
  id: 'bank-1',
  kind: 'bank',
  position: [STUMP_X, WATER_TOP + STUMP_RADIUS, STUMP_Z],
  radius: 0.01,
};

/**
 * The scanned mangrove stump's shape: a wide trunk under the water and a leaning spike about
 * 1.5 cm across whose tip stands 2 cm out of it.
 */
const SPIKE: readonly Collider[] = [
  {
    id: 'trunk',
    hard: true,
    kind: 'capsule',
    a: [-0.3, 0, 0.05],
    b: [-0.3, 0.3, 0.05],
    radius: 0.06,
  },
  {
    id: 'spike',
    hard: true,
    kind: 'capsule',
    a: [-0.3, 0.3, 0.05],
    b: [-0.27, WATER_TOP + 0.012, 0.07],
    radius: 0.008,
  },
];
const SPIKE_TIP: Anchor = {
  id: 'bank-1',
  kind: 'bank',
  position: [-0.27, WATER_TOP + 0.02, 0.07],
  radius: 0.008,
};

function tank(
  fish: readonly FishSpawn[],
  options: { seed?: number; banks?: readonly Anchor[]; decor?: readonly Collider[] } = {},
): World {
  return new World({
    seed: options.seed ?? 5,
    tank: SHOW_TANK,
    species: [BARRED, BLUE_SPOTTED, ...ARCHETYPES],
    decor: options.decor ?? [STUMP],
    fish,
    anchors: options.banks ?? [BANK_AT],
  });
}

interface Tally {
  steps: number;
  emersed: number;
  perched: number;
  haulOuts: number;
  returns: number;
  worstClearance: number;
  highest: number;
}

/** Steps `w` and counts, per fish, time out of the water and complete trips onto the bank. */
function watch(w: World, steps: number): Tally[] {
  const tally = Array.from({ length: w.count }, () => ({
    steps: 0,
    emersed: 0,
    perched: 0,
    haulOuts: 0,
    returns: 0,
    worstClearance: Infinity,
    highest: -Infinity,
  }));
  const wasOut = new Uint8Array(w.count);
  const wasPerched = new Uint8Array(w.count);
  for (let t = 0; t < steps; t++) {
    w.step();
    for (let i = 0; i < w.count; i++) {
      const s = tally[i];
      if (s === undefined) throw new RangeError(`no tally for fish ${i}`);
      const out = w.behaviour.banks.emersed(i);
      const y = at(w.position, i * 3 + 1);
      const perched = out && y > WATER_TOP && at(w.speed, i) === 0;
      s.steps++;
      if (out) s.emersed++;
      if (perched) s.perched++;
      if (perched && wasPerched[i] === 0) s.haulOuts++;
      if (!out && wasOut[i] === 1 && y < WATER_TOP) s.returns++;
      wasOut[i] = out ? 1 : 0;
      wasPerched[i] = perched ? 1 : 0;
      s.worstClearance = Math.min(s.worstClearance, w.bodyClearance(i));
      s.highest = Math.max(s.highest, y);
    }
  }
  return tally;
}

function sum(tally: readonly Tally[], key: keyof Tally): number {
  return tally.reduce((n, t) => n + t[key], 0);
}

function perchedFish(w: World, limit: number): number {
  for (let t = 0; t < limit; t++) {
    w.step();
    for (let i = 0; i < w.count; i++) {
      if (w.behaviour.banks.emersed(i) && at(w.speed, i) === 0) return i;
    }
  }
  throw new Error(`no fish perched within ${limit} steps`);
}

describe('mudskippers on an emergent bank', () => {
  it.each([
    ['a rounded post', [STUMP], BANK_AT],
    ['a leaning spike', SPIKE, SPIKE_TIP],
  ] as const)(
    'haul out onto %s, rest there and go back into the water without touching it',
    (_name, decor, bank) => {
      const w = tank(
        [...spawnMany('barred-mudskipper', 2), ...spawnMany('blue-spotted-mudskipper', 1)],
        { decor, banks: [bank] },
      );
      const tally = watch(w, seconds(20 * 60));
      expect(sum(tally, 'haulOuts')).toBeGreaterThanOrEqual(3);
      expect(sum(tally, 'returns')).toBeGreaterThanOrEqual(sum(tally, 'haulOuts') - 1);
      for (const t of tally) {
        expect(t.worstClearance).toBeGreaterThanOrEqual(-1e-6);
        expect(t.highest).toBeLessThan(bank.position[1] + BLUE_SPOTTED.locomotion.bodyLengthM);
      }
    },
  );

  it('spends a plausible share of its time out of the water', () => {
    const w = tank(spawnMany('barred-mudskipper', 1), { seed: 11 });
    const [t] = watch(w, seconds(60 * 60));
    if (t === undefined) throw new Error('no fish');
    const share = t.emersed / t.steps;
    // Periophthalmus spends most of its active time on land; one bank and the swim to it cap it.
    expect(share).toBeGreaterThan(0.35);
    expect(share).toBeLessThan(0.9);
    const meanBout = t.perched / Math.max(1, t.haulOuts) / STEP_HZ;
    expect(meanBout).toBeGreaterThanOrEqual(BANK.emersedMinS);
    expect(meanBout).toBeLessThanOrEqual(BANK.emersedMaxS);
  });

  it('shares one bank one fish at a time', () => {
    const w = tank(spawnMany('blue-spotted-mudskipper', 3), { seed: 2 });
    for (let t = 0; t < seconds(15 * 60); t++) {
      w.step();
      let out = 0;
      for (let i = 0; i < w.count; i++) if (w.behaviour.banks.emersed(i)) out++;
      expect(out).toBeLessThanOrEqual(1);
    }
  });

  it('runs the same trajectory from the same seed', () => {
    const a = tank(spawnMany('barred-mudskipper', 2), { seed: 9 });
    const b = tank(spawnMany('barred-mudskipper', 2), { seed: 9 });
    for (let t = 0; t < seconds(5 * 60); t++) {
      a.step();
      b.step();
    }
    expect(Array.from(b.position)).toEqual(Array.from(a.position));
    expect(Array.from(b.state)).toEqual(Array.from(a.state));
  });

  it('marks a fish out of the water as emersed in its state', () => {
    const w = tank(spawnMany('barred-mudskipper', 1));
    const i = perchedFish(w, seconds(20 * 60));
    expect(at(w.state, i)).toBe(FishState.Emerse);
    expect(at(w.position, i * 3 + 1)).toBeGreaterThan(WATER_TOP);
    expect(w.behaviour.feeding.eligible[i]).toBe(0);
  });

  it('skips back into the water when startled on the perch', () => {
    const w = tank(spawnMany('barred-mudskipper', 1));
    const i = perchedFish(w, seconds(20 * 60));
    const before = at(w.behaviour.startledAt, i);
    let tries = 0;
    while (at(w.behaviour.startledAt, i) === before) {
      if (++tries > seconds(10)) throw new Error('the tap never startled the fish');
      const o = i * 3;
      w.startle({
        position: [at(w.position, o), at(w.position, o + 1), at(w.position, o + 2)],
        intensity: 1,
      });
      w.step();
    }
    const climbBack =
      (3 * BARRED.locomotion.bodyLengthM) /
      (BANK.skipBodyLengthsPerS * BARRED.locomotion.bodyLengthM);
    for (let t = 0; t < seconds(climbBack + (2 * Math.PI) / BANK.turnRadPerS); t++) w.step();
    expect(w.behaviour.banks.emersed(i)).toBe(false);
    expect(at(w.position, i * 3 + 1)).toBeLessThan(WATER_TOP);
  });

  it('goes back into the water when its bank is taken away', () => {
    const w = tank(spawnMany('barred-mudskipper', 1));
    const i = perchedFish(w, seconds(20 * 60));
    w.setAnchors([]);
    expect(w.behaviour.banks.emersed(i)).toBe(false);
    expect(at(w.position, i * 3 + 1)).toBeLessThan(WATER_TOP);
    expect(w.bodyClearance(i)).toBeGreaterThanOrEqual(-1e-6);
    for (let t = 0; t < seconds(60); t++) w.step();
    expect(at(w.position, i * 3 + 1)).toBeLessThan(WATER_TOP);
  });

  it('keeps an unchanged bank across a new anchor list', () => {
    const w = tank(spawnMany('barred-mudskipper', 1));
    const i = perchedFish(w, seconds(20 * 60));
    const y = at(w.position, i * 3 + 1);
    w.setAnchors([{ ...BANK_AT, position: [...BANK_AT.position] }]);
    w.step();
    expect(w.behaviour.banks.emersed(i)).toBe(true);
    expect(at(w.position, i * 3 + 1)).toBe(y);
  });

  it('stays in the water and gulps air at the surface when there is no bank', () => {
    const w = tank(spawnMany('barred-mudskipper', 2), { banks: [] });
    let gulps = 0;
    for (let t = 0; t < seconds(10 * 60); t++) {
      w.step();
      for (let i = 0; i < w.count; i++) {
        expect(w.behaviour.banks.emersed(i)).toBe(false);
        expect(at(w.position, i * 3 + 1)).toBeLessThan(WATER_TOP);
        if (at(w.state, i) === FishState.Gulp) gulps++;
      }
    }
    expect(gulps).toBeGreaterThan(0);
  });

  it('draws nothing more from the RNG with no bank than before banks existed', () => {
    const none = tank(spawnMany('barred-mudskipper', 2), { banks: [], seed: 4 });
    const bare = new World({
      seed: 4,
      tank: SHOW_TANK,
      species: [BARRED, BLUE_SPOTTED, ...ARCHETYPES],
      decor: [STUMP],
      fish: spawnMany('barred-mudskipper', 2),
    });
    for (let t = 0; t < seconds(60); t++) {
      none.step();
      bare.step();
    }
    expect(none.rng.next()).toBe(bare.rng.next());
  });

  it('leaves fish that are not amphibious in the water', () => {
    const w = tank(spawnMany('bronze-corydoras', 4));
    for (let t = 0; t < seconds(5 * 60); t++) {
      w.step();
      for (let i = 0; i < w.count; i++) {
        expect(at(w.position, i * 3 + 1)).toBeLessThan(WATER_TOP);
      }
    }
  });

  it('never climbs to a bank out of reach', () => {
    const high: Anchor = { ...BANK_AT, position: [STUMP_X, WATER_TOP + 0.5, STUMP_Z] };
    const w = tank(spawnMany('barred-mudskipper', 2), { banks: [high] });
    for (let t = 0; t < seconds(5 * 60); t++) {
      w.step();
      for (let i = 0; i < w.count; i++) expect(w.behaviour.banks.emersed(i)).toBe(false);
    }
  });

  it('rejects a bank under the water or outside the tank', () => {
    const w = tank(spawnMany('barred-mudskipper', 1));
    expect(() =>
      w.setAnchors([{ ...BANK_AT, position: [STUMP_X, WATER_TOP - 0.01, STUMP_Z] }]),
    ).toThrow(/not above the water/);
    expect(() => w.setAnchors([{ ...BANK_AT, position: [5, WATER_TOP + 0.02, 0] }])).toThrow(
      /outside the tank/,
    );
    expect(() => w.setAnchors([{ ...BANK_AT, radius: 0 }])).toThrow(/radius must be positive/);
  });

  it('takes a breath it owed in the water on the perch', () => {
    // A frequent breath that a strong current keeps putting off is often still owed at the bank.
    const gasping = {
      ...BARRED,
      behaviour: { ...BARRED.behaviour, airGulp: { perHour: 360 } },
    };
    const w = new World({
      seed: 5,
      tank: SHOW_TANK,
      species: [gasping, BLUE_SPOTTED, ...ARCHETYPES],
      decor: [STUMP],
      fish: spawnMany('barred-mudskipper', 2),
      anchors: [BANK_AT],
      waveMaker: {
        direction: [1, 0.3],
        speedMps: WAVE_MAKER.maxSpeedMps,
        mode: 'steady',
        periodS: WAVE_MAKER.pulsePeriodS,
      },
    });
    const wait = w.behaviour.gulpWait;
    const owed = new Float64Array(w.count);
    const wasPerched = new Uint8Array(w.count);
    const wasOut = new Uint8Array(w.count);
    let arrivedOwing = 0;
    let returnedOwing = 0;
    let returns = 0;
    for (let t = 0; t < seconds(30 * 60); t++) {
      w.step();
      for (let i = 0; i < w.count; i++) {
        const perched = w.behaviour.banks.perched(i);
        const out = w.behaviour.banks.emersed(i);
        if (perched) expect(at(wait, i)).toBe(0);
        if (perched && wasPerched[i] === 0 && at(owed, i) > 0) arrivedOwing++;
        if (!out && wasOut[i] === 1) {
          returns++;
          if (at(wait, i) > 0) returnedOwing++;
        }
        owed[i] = at(wait, i);
        wasPerched[i] = perched ? 1 : 0;
        wasOut[i] = out ? 1 : 0;
      }
    }
    expect(arrivedOwing).toBeGreaterThan(0);
    expect(returns).toBeGreaterThan(0);
    expect(returnedOwing).toBe(0);
  });

  it('goes back into the water without touching anything when its bank moves', () => {
    const w = tank(spawnMany('barred-mudskipper', 1));
    const i = perchedFish(w, seconds(20 * 60));
    const dx = -0.2;
    w.setDecor([
      { ...STUMP, a: [STUMP_X + dx, 0, STUMP_Z], b: [STUMP_X + dx, WATER_TOP, STUMP_Z] },
    ]);
    w.setAnchors([{ ...BANK_AT, position: [STUMP_X + dx, WATER_TOP + STUMP_RADIUS, STUMP_Z] }]);
    expect(w.behaviour.banks.emersed(i)).toBe(false);
    expect(at(w.position, i * 3 + 1)).toBeLessThan(WATER_TOP);
    const contacts = w.contacts;
    let worst = w.bodyClearance(i);
    for (let t = 0; t < seconds(10); t++) {
      w.step();
      worst = Math.min(worst, w.bodyClearance(i));
      expect(at(w.position, i * 3 + 1)).toBeLessThan(WATER_TOP);
    }
    expect(worst).toBeGreaterThanOrEqual(-1e-6);
    expect(w.contacts).toBe(contacts);
  });

  it('goes back into the water without touching anything when decor lands on its perch', () => {
    const w = tank(spawnMany('barred-mudskipper', 1));
    const i = perchedFish(w, seconds(20 * 60));
    const o = i * 3;
    const rock: Collider = {
      id: 'rock',
      hard: true,
      kind: 'sphere',
      center: [at(w.position, o), at(w.position, o + 1), at(w.position, o + 2)],
      radius: 0.02,
    };
    w.setDecor([STUMP, rock]);
    expect(w.behaviour.banks.emersed(i)).toBe(false);
    expect(at(w.position, o + 1)).toBeLessThan(WATER_TOP);
    const contacts = w.contacts;
    let worst = w.bodyClearance(i);
    for (let t = 0; t < seconds(10); t++) {
      w.step();
      worst = Math.min(worst, w.bodyClearance(i));
      expect(w.behaviour.banks.emersed(i)).toBe(false);
    }
    expect(worst).toBeGreaterThanOrEqual(-1e-6);
    expect(w.contacts).toBe(contacts);
  });

  it('requires an amphibious species to breathe air', () => {
    const notBreathing = {
      ...BARRED,
      behaviour: { ...BARRED.behaviour, traits: ['amphibious' as const] },
    };
    expect(() => toSimSpecies(notBreathing)).toThrow(/air-gulp/);
  });
});
