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

  it('uses the widest corner of an asymmetric footprint', () => {
    const lopsided = { min: [-0.02, 0, -0.1], max: [0.06, 0.4, 0.03] };
    const reach = plantReach('vallisneria', lopsided, DEFAULT_CURRENT);
    const sway = maxSway('vallisneria', 0.4, DEFAULT_CURRENT);
    expect(reach(1)).toBeCloseTo(Math.hypot(0.06, 0.1) + planarLean + sway, 9);
  });
});

describe('plant placement against the glass', () => {
  const extent = { halfLength: 0.5, halfDepth: 0.4 };
  const sway = maxSway('vallisneria', 0.4, DEFAULT_CURRENT);
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
      expect(Math.abs(c.x) + sway).toBeLessThanOrEqual(extent.halfLength + 1e-9);
      expect(Math.abs(c.z) + sway).toBeLessThanOrEqual(extent.halfDepth + 1e-9);
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
    for (const p of plants) expectInside(p);
  });

  it('holds for the worst case: both tilts at maximum, yawed at a wall', () => {
    const scale = 1;
    for (const yaw of [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4, Math.PI]) {
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const r = reach(scale);
          expectInside({
            x: sx * (extent.halfLength - r),
            y: 0,
            z: sz * (extent.halfDepth - r),
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
