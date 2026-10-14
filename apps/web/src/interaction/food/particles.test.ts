import { describe, expect, it } from 'vitest';
import { FoodField, FOOD_STRIDE, MAX_FOOD_PARTICLES, type FoodEnvironment } from './particles';
import { FOOD_PROFILES, FOOD_TYPES, foodTypeIndex } from './profiles';
import { sceneToSim } from './simSpace';

const GROUND = 0.06;

function env(overrides: Partial<FoodEnvironment> = {}): FoodEnvironment {
  return {
    bounds: { minX: -0.59, maxX: 0.59, minZ: -0.24, maxZ: 0.24, waterTop: 0.47 },
    groundHeight: () => GROUND,
    current: (_x, _y, _z, out) => {
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
    },
    ...overrides,
  };
}

const fixedRandom = () => 0.5;

function runFor(field: FoodField, seconds: number, dt = 1 / 30): void {
  for (let t = 0; t < seconds; t += dt) field.step(dt);
}

function meanSinkSpeed(food: 'pellets' | 'algae-wafer' | 'bloodworms' | 'brine-shrimp'): number {
  const field = new FoodField(env(), fixedRandom);
  field.drop(food, 1, 0, 0, 0);
  const p = field.particles[0];
  if (!p) throw new Error('no particle');
  runFor(field, 3);
  const y0 = p.y;
  runFor(field, 1);
  return y0 - p.y;
}

describe('food types', () => {
  it('indexes the shared diet vocabulary in its declared order', () => {
    expect(FOOD_TYPES).toEqual([
      'flakes',
      'pellets',
      'bloodworms',
      'brine-shrimp',
      'nori',
      'algae-wafer',
    ]);
    expect(foodTypeIndex('algae-wafer')).toBe(5);
  });

  it('has a profile for every type', () => {
    for (const food of FOOD_TYPES) expect(FOOD_PROFILES[food].radius).toBeGreaterThan(0);
  });
});

describe('FoodField sinking', () => {
  it('reaches the profile terminal sink speed in still water', () => {
    for (const food of ['pellets', 'algae-wafer', 'bloodworms', 'brine-shrimp'] as const) {
      const profile = FOOD_PROFILES[food];
      const fall = meanSinkSpeed(food);
      expect(Math.abs(fall - profile.sinkSpeed)).toBeLessThan(0.05 * profile.sinkSpeed);
    }
  });

  it('sinks pellets and wafers faster than flakes and brine shrimp', () => {
    expect(meanSinkSpeed('pellets')).toBeGreaterThan(meanSinkSpeed('brine-shrimp') * 3);
    expect(meanSinkSpeed('algae-wafer')).toBeGreaterThan(meanSinkSpeed('pellets'));
  });

  it('keeps flakes at the surface until they are waterlogged, then sinks them', () => {
    const field = new FoodField(env(), fixedRandom);
    field.drop('flakes', 1, 0, 0, 0);
    const top = env().bounds.waterTop;
    runFor(field, FOOD_PROFILES.flakes.floatS - 2);
    for (const p of field.particles) expect(top - p.y).toBeLessThan(0.01);
    runFor(field, 15);
    for (const p of field.particles) expect(top - p.y).toBeGreaterThan(0.05);
  });

  it('never rises above the water surface', () => {
    const field = new FoodField(
      env({
        current: (_x, _y, _z, out) => {
          out[0] = 0;
          out[1] = 0.5;
          out[2] = 0;
        },
      }),
      fixedRandom,
    );
    field.drop('brine-shrimp', 1, 0, 0);
    runFor(field, 10);
    for (const p of field.particles) expect(p.y).toBeLessThanOrEqual(0.47);
  });
});

describe('FoodField settling and decay', () => {
  it('settles on the sand at the local ground height and stops moving', () => {
    const field = new FoodField(env({ groundHeight: (x) => 0.05 + 0.02 * x }), fixedRandom);
    field.drop('pellets', 1, 0.2, 0, 0);
    runFor(field, 60);
    for (const p of field.particles) {
      expect(p.settledS).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeCloseTo(0.05 + 0.02 * p.x, 6);
      expect([p.vx, p.vy, p.vz]).toEqual([0, 0, 0]);
    }
    const before = field.particles.map((p) => [p.x, p.y, p.z]);
    runFor(field, 2);
    expect(field.particles.map((p) => [p.x, p.y, p.z])).toEqual(before);
  });

  it('dissolves settled food after the profile decay time and reports it', () => {
    const field = new FoodField(env(), fixedRandom);
    const made = field.drop('brine-shrimp', 0.5, 0, 0);
    let expired = 0;
    let t = 0;
    while (field.count > 0 && t < 600) {
      expired += field.step(0.1).length;
      t += 0.1;
    }
    expect(expired).toBe(made);
    const minimum = FOOD_PROFILES['brine-shrimp'].decayS;
    expect(t).toBeGreaterThanOrEqual(minimum);
    expect(t).toBeLessThan(minimum + 0.46 / FOOD_PROFILES['brine-shrimp'].sinkSpeed + 10);
  });

  it('does not start the decay clock while a particle is still falling', () => {
    const field = new FoodField(env(), fixedRandom);
    field.drop('flakes', 1, 0, 0);
    runFor(field, 20);
    for (const p of field.particles) expect(p.settledS).toBe(-1);
  });

  it('keeps wafers around much longer than flakes', () => {
    expect(FOOD_PROFILES['algae-wafer'].decayS).toBeGreaterThan(FOOD_PROFILES.flakes.decayS * 5);
  });
});

describe('FoodField current', () => {
  const east = env({
    current: (_x, _y, _z, out) => {
      out[0] = 0.12;
      out[1] = 0;
      out[2] = 0;
    },
  });

  it('drifts light food further downstream than heavy food', () => {
    const light = new FoodField(east, fixedRandom);
    const heavy = new FoodField(east, fixedRandom);
    light.drop('brine-shrimp', 0.1, -0.3, 0, 0);
    heavy.drop('algae-wafer', 1, -0.3, 0, 0);
    runFor(light, 4);
    runFor(heavy, 4);
    const dx = (f: FoodField) => (f.particles[0]?.x ?? 0) + 0.3;
    expect(dx(light)).toBeGreaterThan(0.03);
    expect(dx(heavy)).toBeLessThan(dx(light) / 2);
  });

  it('stops against the end glass instead of leaving the tank', () => {
    const field = new FoodField(east, fixedRandom);
    field.drop('brine-shrimp', 1, 0.5, 0);
    runFor(field, 30);
    for (const p of field.particles) expect(p.x).toBeLessThanOrEqual(0.59);
  });
});

describe('FoodField edges', () => {
  it('rejects non-positive portions', () => {
    const field = new FoodField(env(), fixedRandom);
    expect(() => field.drop('flakes', 0, 0, 0)).toThrow(RangeError);
    expect(() => field.drop('flakes', -1, 0, 0)).toThrow(RangeError);
  });

  it('always makes at least one particle for a tiny portion', () => {
    const field = new FoodField(env(), fixedRandom);
    expect(field.drop('algae-wafer', 0.1, 0, 0)).toBe(1);
  });

  it('caps the particle count and reports how many were made', () => {
    const field = new FoodField(env(), fixedRandom);
    let made = 0;
    for (let i = 0; i < 60; i++) made += field.drop('brine-shrimp', 1, 0, 0);
    expect(field.count).toBe(MAX_FOOD_PARTICLES);
    expect(made).toBe(MAX_FOOD_PARTICLES);
    expect(field.drop('flakes', 1, 0, 0)).toBe(0);
  });

  it('clamps the drop point inside the glass', () => {
    const field = new FoodField(env(), fixedRandom);
    field.drop('pellets', 1, 5, -5, 0);
    for (const p of field.particles) {
      expect(p.x).toBeLessThan(0.59);
      expect(p.z).toBeGreaterThan(-0.24);
    }
  });

  it('ignores a zero step and rejects a negative one', () => {
    const field = new FoodField(env(), fixedRandom);
    field.drop('pellets', 1, 0, 0);
    const y = field.particles.map((p) => p.y);
    field.step(0);
    expect(field.particles.map((p) => p.y)).toEqual(y);
    expect(() => field.step(-1)).toThrow(RangeError);
  });

  it('caps a huge frame step so a stalled tab cannot tunnel through the floor', () => {
    const field = new FoodField(env(), fixedRandom);
    field.drop('algae-wafer', 1, 0, 0);
    field.step(30);
    const p = field.particles[0];
    expect(p?.y).toBeGreaterThan(0.4);
  });

  it('removes eaten particles by id and ignores unknown ids', () => {
    const field = new FoodField(env(), fixedRandom);
    field.drop('pellets', 1, 0, 0);
    const ids = field.particles.map((p) => p.id);
    const removed = field.remove([ids[0] ?? -1, 9999]);
    expect(removed.map((p) => p.id)).toEqual([ids[0]]);
    expect(field.count).toBe(ids.length - 1);
    expect(field.remove([])).toEqual([]);
  });
});

describe('FoodField.pack', () => {
  it('writes id, sim-space position and type index with stride 5', () => {
    const field = new FoodField(env(), fixedRandom);
    field.drop('pellets', 0.25, 0.1, -0.05, 0);
    field.drop('nori', 1, -0.1, 0.05, 0);
    const buf = field.pack(sceneToSim(() => GROUND));
    expect(buf).toBeInstanceOf(Float32Array);
    expect(buf.length).toBe(field.count * FOOD_STRIDE);
    const first = field.particles[0];
    expect(buf[0]).toBe(first?.id);
    expect(buf[1]).toBeCloseTo(first?.x ?? NaN, 5);
    expect(buf[2]).toBeCloseTo((first?.y ?? NaN) - GROUND, 5);
    expect(buf[4]).toBe(foodTypeIndex('pellets'));
    expect(buf[(field.count - 1) * FOOD_STRIDE + 4]).toBe(foodTypeIndex('nori'));
  });

  it('puts settled food at sim y = 0 and never below', () => {
    const field = new FoodField(env(), fixedRandom);
    field.drop('algae-wafer', 1, 0, 0);
    runFor(field, 30);
    const buf = field.pack(sceneToSim(() => GROUND));
    expect(buf[2]).toBe(0);
  });

  it('packs an empty field to an empty buffer', () => {
    expect(new FoodField(env()).pack(sceneToSim(() => 0)).length).toBe(0);
  });
});
