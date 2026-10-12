import { describe, expect, it } from 'vitest';
import { DEFAULT_TANK, validateTank, WATER_INSET, waterBounds } from './dimensions';
import { substrateHeight } from './substrate';

describe('validateTank', () => {
  it('accepts the default tank', () => {
    expect(() => validateTank(DEFAULT_TANK)).not.toThrow();
  });

  it.each([
    [{ length: 0 }, /length/],
    [{ glass: -0.01 }, /glass/],
    [{ freeboard: -0.01 }, /freeboard/],
    [{ glass: 0.3 }, /thicker/],
    [{ substrateBack: -0.01 }, /substrate/],
    [{ substrateBack: 0.5 }, /above the water/],
  ])('rejects %o', (patch, message) => {
    expect(() => validateTank({ ...DEFAULT_TANK, ...patch })).toThrow(message);
  });
});

describe('waterBounds', () => {
  it('sits inside the glass with the inset and stops at the freeboard', () => {
    const b = waterBounds(DEFAULT_TANK);
    const { length, depth, height, glass, freeboard } = DEFAULT_TANK;
    expect(b.min.x).toBeCloseTo(-length / 2 + glass + WATER_INSET, 9);
    expect(b.max.z).toBeCloseTo(depth / 2 - glass - WATER_INSET, 9);
    expect(b.min.y).toBeCloseTo(glass + WATER_INSET, 9);
    expect(b.max.y).toBeCloseTo(height - freeboard, 9);
  });
});

describe('substrateHeight', () => {
  it('rises from front to back and stays under water', () => {
    const front = substrateHeight(DEFAULT_TANK, 0, DEFAULT_TANK.depth / 2);
    const back = substrateHeight(DEFAULT_TANK, 0, -DEFAULT_TANK.depth / 2);
    expect(back).toBeGreaterThan(front);
    const top = waterBounds(DEFAULT_TANK).max.y;
    for (let x = -0.59; x <= 0.59; x += 0.05) {
      for (let z = -0.24; z <= 0.24; z += 0.04) {
        const y = substrateHeight(DEFAULT_TANK, x, z);
        expect(y).toBeGreaterThan(DEFAULT_TANK.glass);
        expect(y).toBeLessThan(top);
      }
    }
  });
});
