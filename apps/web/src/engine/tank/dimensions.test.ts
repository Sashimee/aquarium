import { describe, expect, it } from 'vitest';
import { TANK_SIZES, tankSizeSchema, type TankSize } from '@aquarium/shared';
import { Box3, PerspectiveCamera, Vector3 } from 'three/webgpu';
import {
  DEFAULT_TANK,
  defaultView,
  framingScale,
  sameTank,
  TANK_DIMENSIONS,
  type TankDimensions,
  validateTank,
  WATER_INSET,
  waterBounds,
  waterLitres,
} from './dimensions';
import { meanSubstrateHeight, substrateHeight } from './substrate';

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

describe('TANK_DIMENSIONS', () => {
  it.each(tankSizeSchema.options)('builds a valid %s tank on the shared glass size', (size) => {
    const d = TANK_DIMENSIONS[size];
    expect(() => validateTank(d)).not.toThrow();
    expect(d).toMatchObject(TANK_SIZES[size].dimensions);
  });

  it('keeps the standard tank as the default one', () => {
    expect(DEFAULT_TANK).toBe(TANK_DIMENSIONS.standard);
  });

  it.each(tankSizeSchema.options)('holds a bit less than the %s label says', (size) => {
    const litres = waterLitres(TANK_DIMENSIONS[size]);
    expect(litres).toBeLessThan(TANK_SIZES[size].litres);
    expect(litres).toBeGreaterThan(TANK_SIZES[size].litres * 0.8);
  });

  it('orders the sizes by the water they hold', () => {
    const litres = (['nano30', 'std200', 'long300'] as const).map((s) =>
      waterLitres(TANK_DIMENSIONS[s]),
    );
    expect(litres).toEqual([...litres].sort((a, b) => a - b));
  });
});

describe('waterBounds target', () => {
  it('writes into the box it is given', () => {
    const box = new Box3();
    expect(waterBounds(TANK_DIMENSIONS.nano30, box)).toBe(box);
    expect(box.equals(waterBounds(TANK_DIMENSIONS.nano30))).toBe(true);
  });
});

describe('sameTank', () => {
  it('compares every dimension', () => {
    expect(sameTank(DEFAULT_TANK, { ...DEFAULT_TANK })).toBe(true);
    expect(sameTank(DEFAULT_TANK, { ...DEFAULT_TANK, freeboard: 0.031 })).toBe(false);
    expect(sameTank(TANK_DIMENSIONS.std200, TANK_DIMENSIONS.long300)).toBe(false);
  });
});

describe('framingScale', () => {
  it('stands back for the longer tank and closer for the nano', () => {
    expect(framingScale(DEFAULT_TANK)).toBe(1);
    expect(framingScale(TANK_DIMENSIONS.long300)).toBeCloseTo(1.25, 12);
    expect(framingScale(TANK_DIMENSIONS.nano30)).toBeCloseTo(0.6, 12);
    expect(framingScale(TANK_DIMENSIONS.std200)).toBe(1);
  });
});

describe('defaultView', () => {
  const corners = (d: TankDimensions): Vector3[] =>
    [-1, 1].flatMap((x) =>
      [0, 1].flatMap((y) =>
        [-1, 1].map((z) => new Vector3((x * d.length) / 2, y * d.height, (z * d.depth) / 2)),
      ),
    );
  const projected = (size: TankSize): Vector3[] => {
    const d = TANK_DIMENSIONS[size];
    const camera = new PerspectiveCamera(40, 16 / 9, 0.05, 50);
    const { eye, target } = defaultView(d);
    camera.position.copy(eye);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    return corners(d).map((c) => c.project(camera));
  };
  const screenHeight = (points: Vector3[]): number =>
    Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y));

  it('keeps the standard view the engine always had', () => {
    const { eye, target } = defaultView(DEFAULT_TANK);
    expect(eye.toArray()).toEqual([0, 0.35, 1.6]);
    expect(target.toArray()).toEqual([0, 0.25, 0]);
  });

  it.each(tankSizeSchema.options)('shows the whole %s tank on a 16:9 screen', (size) => {
    for (const p of projected(size)) {
      expect(Math.abs(p.x)).toBeLessThan(1);
      expect(Math.abs(p.y)).toBeLessThan(1);
      expect(p.z).toBeLessThan(1);
    }
  });

  it.each(tankSizeSchema.options)(
    'fills no more of the screen with %s than the standard',
    (size) => {
      expect(screenHeight(projected(size))).toBeLessThanOrEqual(
        screenHeight(projected('standard')) + 1e-9,
      );
    },
  );

  it('brings the nano close enough to fill the screen like the standard does', () => {
    expect(screenHeight(projected('nano30'))).toBeGreaterThan(
      0.9 * screenHeight(projected('standard')),
    );
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

describe('meanSubstrateHeight', () => {
  it('is the average of the substrate top over the floor', () => {
    const tank = { ...DEFAULT_TANK, substrateFront: 0.03, substrateBack: 0.12 };
    const halfL = tank.length / 2 - tank.glass;
    const halfD = tank.depth / 2 - tank.glass;
    const n = 400;
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const z = -halfD + (2 * halfD * (j + 0.5)) / n;
      for (let i = 0; i < n; i++) {
        sum += substrateHeight(tank, -halfL + (2 * halfL * (i + 0.5)) / n, z);
      }
    }
    expect(meanSubstrateHeight(tank)).toBeCloseTo(sum / (n * n), 3);
    expect(meanSubstrateHeight(tank)).toBeGreaterThan(waterBounds(tank).min.y);
  });
});
