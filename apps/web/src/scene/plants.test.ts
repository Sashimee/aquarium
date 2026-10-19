import { Euler, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { TIER_SETTINGS } from '../engine/quality/tiers';
import type { PlantPatch } from '@aquarium/shared';
import { MAX_TILT_RAD, scatterPatch } from './placement';
import { maxSway, visibleAtDensity } from './plants';
import { DEFAULT_CURRENT, plantReach } from './TankScene';

describe('visibleAtDensity', () => {
  const ranked = Array.from({ length: 20 }, (_, i) => ({ rank: i / 20 }));
  const layout = [{ rank: -1 }, { rank: -1 }];

  it('thins patches per tier and never adds plants on a lower tier', () => {
    const counts = (['low', 'medium', 'high', 'ultra'] as const).map((tier) =>
      visibleAtDensity(ranked, TIER_SETTINGS[tier].plantDensity),
    );
    expect(counts).toEqual([8, 14, 20, 20]);
    expect([...counts].sort((a, b) => a - b)).toEqual(counts);
  });

  it('always shows layout plants', () => {
    expect(visibleAtDensity(layout, 0)).toBe(2);
    expect(visibleAtDensity([...ranked, ...layout], 0.4)).toBe(10);
  });

  it('shows nothing at zero density', () => {
    expect(visibleAtDensity(ranked, 0)).toBe(0);
  });
});

describe('maxSway', () => {
  const current = { direction: [1, 0] as const, speed: 0.05, gustPeriodS: 8, gustDepth: 0.45 };

  it('grows with plant height and current speed', () => {
    expect(maxSway('vallisneria', 0.4, current)).toBeGreaterThan(
      maxSway('vallisneria', 0.2, current),
    );
    expect(maxSway('vallisneria', 0.3, { ...current, speed: 0.1 })).toBeGreaterThan(
      maxSway('vallisneria', 0.3, current),
    );
  });

  it('is smaller for stiff plants', () => {
    expect(maxSway('java-fern', 0.3, current)).toBeLessThan(maxSway('vallisneria', 0.3, current));
  });
});

describe('maxSway per axis', () => {
  const current = { direction: [1, 0] as const, speed: 0.05, gustPeriodS: 8, gustDepth: 0.45 };

  it('puts the forward lean on the flow axis and only the meander across it', () => {
    const x = maxSway('vallisneria', 0.4, current, 'x');
    const z = maxSway('vallisneria', 0.4, current, 'z');
    expect(z).toBeLessThan(x / 3);
    expect(x).toBeLessThanOrEqual(maxSway('vallisneria', 0.4, current));
  });

  it('normalises the direction like the shader, so a longer vector sways no further', () => {
    const unit = { ...current, direction: [0.6, 0.8] as const };
    const long = { ...current, direction: [3, 4] as const };
    for (const axis of ['x', 'z'] as const) {
      expect(maxSway('vallisneria', 0.4, long, axis)).toBeCloseTo(
        maxSway('vallisneria', 0.4, unit, axis),
        12,
      );
    }
  });

  it('rejects a zero direction, as the current field does', () => {
    expect(() => maxSway('vallisneria', 0.4, { ...current, direction: [0, 0] }, 'x')).toThrow(
      RangeError,
    );
  });

  it('swaps axes when the current runs along z', () => {
    const turned = { ...current, direction: [0, 1] as const };
    expect(maxSway('vallisneria', 0.4, turned, 'z')).toBeCloseTo(
      maxSway('vallisneria', 0.4, current, 'x'),
      12,
    );
    expect(maxSway('vallisneria', 0.4, turned, 'x')).toBeCloseTo(
      maxSway('vallisneria', 0.4, current, 'z'),
      12,
    );
  });
});

const bounds = { min: [-0.05, 0, -0.05], max: [0.05, 0.4, 0.05] };
const half = Math.hypot(0.05, 0.05);
const planarLean = Math.sin(MAX_TILT_RAD) * Math.sqrt(1 + Math.cos(MAX_TILT_RAD) ** 2) * 0.4;

describe('plantReach', () => {
  it('adds the shader lean in world units, unaffected by instance scale', () => {
    const reach = plantReach('vallisneria', bounds, DEFAULT_CURRENT);
    const sway = maxSway('vallisneria', 0.4, DEFAULT_CURRENT);
    expect(sway).toBeGreaterThan(0);
    expect(reach(0)).toBeCloseTo(sway, 9);
    expect(reach(0.5) - reach(0)).toBeGreaterThan(0);
  });

  it('scales footprint diagonal and two-axis tilt lean, then adds the full sway', () => {
    const reach = plantReach('vallisneria', bounds, DEFAULT_CURRENT);
    const sway = maxSway('vallisneria', 0.4, DEFAULT_CURRENT);
    for (const s of [0.5, 1, 1.5]) {
      expect(reach(s)).toBeCloseTo((half + planarLean) * s + sway, 9);
    }
  });

  it('reaches less towards z than x when the current runs along x', () => {
    const reach = plantReach('vallisneria', bounds, DEFAULT_CURRENT);
    expect(reach(1, 'z')).toBeLessThan(reach(1, 'x'));
    expect(reach(1, 'x')).toBeLessThanOrEqual(reach(1));
  });

  it('uses the widest corner of an asymmetric footprint', () => {
    const lopsided = { min: [-0.02, 0, -0.1], max: [0.06, 0.4, 0.03] };
    const reach = plantReach('vallisneria', lopsided, DEFAULT_CURRENT);
    const sway = maxSway('vallisneria', 0.4, DEFAULT_CURRENT);
    expect(reach(1)).toBeCloseTo(Math.hypot(0.06, 0.1) + planarLean + sway, 9);
  });

  it('takes the height from the larger of the extents above and below the origin', () => {
    const sunken = { min: [-0.05, -0.4, -0.05], max: [0.05, 0.1, 0.05] };
    const reach = plantReach('vallisneria', sunken, DEFAULT_CURRENT);
    const sway = maxSway('vallisneria', 0.4, DEFAULT_CURRENT);
    expect(reach(1)).toBeCloseTo(half + planarLean + sway, 9);
  });
});

describe('plant placement against the glass', () => {
  const extent = { halfLength: 0.5, halfDepth: 0.4 };
  const swayX = maxSway('vallisneria', 0.4, DEFAULT_CURRENT, 'x');
  const swayZ = maxSway('vallisneria', 0.4, DEFAULT_CURRENT, 'z');
  const reach = plantReach('vallisneria', bounds, DEFAULT_CURRENT);
  const patch: PlantPatch = {
    id: 'edge',
    assetId: 'vallisneria',
    center: [0.45, 0.3],
    radius: 0.2,
    count: 40,
    scale: [0.4, 0.9],
    seed: 11,
  };
  const corners = [-0.05, 0.05].flatMap((cx) =>
    [0, 0.4].flatMap((cy) => [-0.05, 0.05].map((cz) => [cx, cy, cz] as const)),
  );

  const worldCorners = (p: {
    x: number;
    y: number;
    z: number;
    yaw: number;
    tiltX: number;
    tiltZ: number;
    scale: number;
  }) => {
    const q = new Quaternion().setFromEuler(new Euler(p.tiltX, p.yaw, p.tiltZ, 'YXZ'));
    return corners.map(([cx, cy, cz]) =>
      new Vector3(cx, cy, cz)
        .multiplyScalar(p.scale)
        .applyQuaternion(q)
        .add(new Vector3(p.x, p.y, p.z)),
    );
  };

  const expectInside = (plant: Parameters<typeof worldCorners>[0]) => {
    for (const c of worldCorners(plant)) {
      expect(Math.abs(c.x) + swayX).toBeLessThanOrEqual(extent.halfLength + 1e-9);
      expect(Math.abs(c.z) + swayZ).toBeLessThanOrEqual(extent.halfDepth + 1e-9);
    }
  };

  it('keeps every rotated bounding-box corner of scattered plants inside the glass', () => {
    const plants = scatterPatch(
      patch,
      () => 0,
      () => false,
      extent,
      reach,
    );
    expect(plants.length).toBeGreaterThan(0);
    for (const p of plants) {
      expect(p.scale).toBeLessThan(1);
      expectInside(p);
    }
  });

  it('holds for the worst case: both tilts at maximum, yawed at a wall', () => {
    const scale = 1;
    for (const yaw of [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4, Math.PI]) {
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const rx = reach(scale, 'x');
          const rz = reach(scale, 'z');
          expectInside({
            x: sx * (extent.halfLength - rx),
            y: 0,
            z: sz * (extent.halfDepth - rz),
            yaw,
            tiltX: sx * MAX_TILT_RAD,
            tiltZ: sz * MAX_TILT_RAD,
            scale,
          });
        }
      }
    }
  });
});
