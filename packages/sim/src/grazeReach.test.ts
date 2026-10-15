import { describe, expect, it } from 'vitest';
import type { Point3 } from './decor.ts';
import {
  ARCHETYPES,
  blueTang,
  FoodRain,
  REEF_DECOR,
  REEF_TANK,
  spawnMany,
  yellowTang,
} from './fixtures.ts';
import { STEP_HZ, World, type FishSpawn } from './world.ts';

// Long simulations: well under a second locally, but shared CI runners can be several times slower.
const LONG = 60_000;

/**
 * #302: nori clipped to the back glass behind the right-hand rock, where the slot to the glass is
 * 4-5 cm at the centre line and a tang needs about 17 cm to turn. Above the rock's narrow part
 * there is room.
 */
const SLOT: Point3 = [0.55, 0.15, -0.29];
const ABOVE: Point3 = [0.55, 0.25, -0.29];

function reef(seed: number, fish: readonly FishSpawn[]): World {
  return new World({ seed, tank: REEF_TANK, species: ARCHETYPES, decor: REEF_DECOR, fish });
}

/** The step of the first bite on a nori clip at `at`, or -1 within `steps`. */
function firstBite(w: World, at: Point3, steps: number): number {
  const rain = new FoodRain(REEF_TANK);
  const nori = rain.place('nori', ...at);
  for (let t = 0; t < steps; t++) {
    rain.feed(w);
    w.step();
    const events = w.takeAteEvents();
    rain.eat(events);
    if (events.some((e) => e.foodId === nori)) return t;
  }
  return -1;
}

describe('World.canGrazeAt', () => {
  for (const sp of [yellowTang, blueTang]) {
    it(`refuses the slot behind the rock for a ${sp.id} and allows the glass above it`, () => {
      const w = reef(1, spawnMany(sp.id, 1));
      expect(w.canGrazeAt(sp.id, ...SLOT)).toBe(false);
      expect(w.canGrazeAt(sp.id, ...ABOVE)).toBe(true);
    });

    it(`matches what a ${sp.id} actually eats`, { timeout: LONG }, () => {
      for (const seed of [1, 2, 3]) {
        expect(firstBite(reef(seed, spawnMany(sp.id, 1)), SLOT, 20 * STEP_HZ), `seed ${seed}`).toBe(
          -1,
        );
        expect(
          firstBite(reef(seed, spawnMany(sp.id, 1)), ABOVE, 20 * STEP_HZ),
          `seed ${seed}`,
        ).toBeGreaterThan(0);
      }
    });
  }

  it('allows open water and refuses a point buried in rock', () => {
    const w = reef(1, spawnMany(yellowTang.id, 1));
    expect(w.canGrazeAt(yellowTang.id, 0, 0.3, 0)).toBe(true);
    expect(w.canGrazeAt(yellowTang.id, 0.55, 0.1, -0.12)).toBe(false);
  });

  it('judges a species with no fish in the tank at its adult length', () => {
    const none = reef(1, spawnMany(yellowTang.id, 1));
    const own = reef(1, spawnMany(blueTang.id, 1));
    for (const at of [SLOT, ABOVE]) {
      expect(none.canGrazeAt(blueTang.id, ...at)).toBe(own.canGrazeAt(blueTang.id, ...at));
    }
  });

  it('allows a spot that only the smallest fish of the species can turn in', () => {
    const fry: FishSpawn = { id: 'fry', species: yellowTang.id, bodyLengthM: 0.03 };
    const adults = spawnMany(yellowTang.id, 2);
    expect(reef(1, adults).canGrazeAt(yellowTang.id, ...SLOT)).toBe(false);
    expect(reef(1, [...adults, fry]).canGrazeAt(yellowTang.id, ...SLOT)).toBe(true);
  });

  it('leaves the trajectory unchanged when asked between steps', { timeout: LONG }, () => {
    const plain = reef(7, spawnMany(yellowTang.id, 3));
    const asked = reef(7, spawnMany(yellowTang.id, 3));
    const plainRain = new FoodRain(REEF_TANK);
    const askedRain = new FoodRain(REEF_TANK);
    plainRain.place('nori', ...ABOVE);
    askedRain.place('nori', ...ABOVE);
    for (let t = 0; t < 10 * STEP_HZ; t++) {
      plainRain.feed(plain);
      askedRain.feed(asked);
      asked.canGrazeAt(yellowTang.id, ...SLOT);
      asked.canGrazeAt(blueTang.id, ...ABOVE);
      plain.step();
      asked.step();
      plainRain.eat(plain.takeAteEvents());
      askedRain.eat(asked.takeAteEvents());
    }
    expect(Array.from(asked.position)).toEqual(Array.from(plain.position));
    expect(Array.from(asked.yaw)).toEqual(Array.from(plain.yaw));
    expect(Array.from(asked.pitch)).toEqual(Array.from(plain.pitch));
    expect(asked.behaviour.feeding.gut).toEqual(plain.behaviour.feeding.gut);
  });

  it('judges a point on the reach boundary as the float32 food sent there', () => {
    const w = reef(1, spawnMany(yellowTang.id, 1));
    const [x, , z] = SLOT;
    const reach = (y: number): boolean => w.canGrazeAt(yellowTang.id, x, y, z);
    let lo = Math.fround(0.2);
    let hi = Math.fround(0.25);
    expect([reach(lo), reach(hi)]).toEqual([false, true]);
    for (;;) {
      const mid = Math.fround((lo + hi) / 2);
      if (mid === lo || mid === hi) break;
      if (reach(mid)) hi = mid;
      else lo = mid;
    }
    // Neighbouring float32 values either side of the boundary; float64 points between them are
    // food the client would send as one or the other.
    for (const t of [0.01, 0.25, 0.49, 0.51, 0.75, 0.99]) {
      const y = lo + (hi - lo) * t;
      expect(Math.fround(y)).not.toBe(y);
      expect(reach(y), `y ${y}`).toBe(reach(Math.fround(y)));
    }
  });

  it('rejects an unknown species and a non-finite position', () => {
    const w = reef(1, spawnMany(yellowTang.id, 1));
    expect(() => w.canGrazeAt('no-such-fish', ...ABOVE)).toThrow(/unknown species "no-such-fish"/);
    expect(() => w.canGrazeAt(yellowTang.id, Number.NaN, 0.2, 0)).toThrow(RangeError);
    expect(() => w.canGrazeAt(yellowTang.id, 0, Infinity, 0)).toThrow(RangeError);
  });
});
