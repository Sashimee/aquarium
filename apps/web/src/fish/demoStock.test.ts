import { describe, expect, it } from 'vitest';
import { DEFAULT_TANK, WATER_INSET } from '../engine/tank/dimensions';
import { DEMO_COUNTS, DEMO_MAX_LENGTH_M, DEMO_SPECIES, demoTank } from './demoStock';

describe('demoTank', () => {
  it('spawns the demo counts with unique ids for known species', () => {
    const { config } = demoTank(DEFAULT_TANK, 1);
    const total = Object.values(DEMO_COUNTS).reduce((a, b) => a + b, 0);
    expect(config.fish).toHaveLength(total);
    expect(new Set(config.fish.map((f) => f.id)).size).toBe(total);
    const known = new Set(DEMO_SPECIES.map((s) => s.id));
    for (const spawn of config.fish) expect(known.has(spawn.species)).toBe(true);
  });

  it('fits the sim tank inside the water above the substrate', () => {
    const { config, offset } = demoTank(DEFAULT_TANK, 1);
    const t = DEFAULT_TANK;
    expect(config.tank.width).toBeCloseTo(t.length - 2 * (t.glass + WATER_INSET), 9);
    expect(config.tank.depth).toBeCloseTo(t.depth - 2 * (t.glass + WATER_INSET), 9);
    const floorY = offset[1];
    expect(floorY).toBeGreaterThan(t.glass + Math.max(t.substrateFront, t.substrateBack));
    expect(floorY + config.tank.height).toBeCloseTo(t.height - t.freeboard, 9);
    expect(config.tank.height).toBeGreaterThan(0);
    expect(offset[0]).toBe(0);
    expect(offset[2]).toBe(0);
  });

  it('varies body lengths by at most 8% around the species length', () => {
    const { config } = demoTank(DEFAULT_TANK, 7);
    const lengths = new Map(DEMO_SPECIES.map((s) => [s.id, s.locomotion.bodyLengthM]));
    for (const spawn of config.fish) {
      const base = lengths.get(spawn.species) ?? Number.NaN;
      expect(Math.abs((spawn.bodyLengthM ?? Number.NaN) / base - 1)).toBeLessThanOrEqual(0.08);
    }
  });

  it('never spawns a fish longer than its species grows in content', () => {
    for (const species of DEMO_SPECIES) {
      expect(DEMO_MAX_LENGTH_M[species.id], species.id).toBeGreaterThan(0);
    }
    for (let seed = 0; seed < 50; seed++) {
      for (const spawn of demoTank(DEFAULT_TANK, seed).config.fish) {
        const max = DEMO_MAX_LENGTH_M[spawn.species] ?? Number.NaN;
        expect(spawn.bodyLengthM ?? Number.NaN).toBeLessThanOrEqual(max);
      }
    }
  });

  it('is deterministic per seed', () => {
    const a = demoTank(DEFAULT_TANK, 42).config.fish.map((f) => f.bodyLengthM);
    const b = demoTank(DEFAULT_TANK, 42).config.fish.map((f) => f.bodyLengthM);
    const c = demoTank(DEFAULT_TANK, 43).config.fish.map((f) => f.bodyLengthM);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});
