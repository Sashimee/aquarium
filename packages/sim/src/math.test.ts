import { describe, expect, it } from 'vitest';
import { DEG, quatFromYawPitchRoll, rotateByQuat, wrapAngle, type Vec3 } from './math.ts';

function rotate(yaw: number, pitch: number, roll: number, v: Vec3): Vec3 {
  const q = new Float64Array(4);
  quatFromYawPitchRoll(yaw, pitch, roll, q, 0);
  return rotateByQuat(q, 0, v);
}

function expectVec(actual: Vec3, expected: Vec3): void {
  actual.forEach((c, k) => expect(c).toBeCloseTo(expected[k] ?? NaN, 9));
}

describe('wrapAngle', () => {
  it('maps any angle into [-π, π]', () => {
    for (const a of [0, 1, -1, Math.PI, -Math.PI, 3 * Math.PI, -7.5, 100]) {
      const w = wrapAngle(a);
      expect(w).toBeGreaterThanOrEqual(-Math.PI);
      expect(w).toBeLessThanOrEqual(Math.PI);
      expect(Math.cos(w)).toBeCloseTo(Math.cos(a), 9);
      expect(Math.sin(w)).toBeCloseTo(Math.sin(a), 9);
    }
  });
});

describe('quatFromYawPitchRoll', () => {
  it('produces unit quaternions', () => {
    const q = new Float64Array(4);
    quatFromYawPitchRoll(0.7, -0.3, 0.4, q, 0);
    expect(Math.hypot(...q)).toBeCloseTo(1, 12);
  });

  it('maps body +Z onto the heading used by the simulation', () => {
    for (const [yaw, pitch] of [
      [0, 0],
      [0.9, 0.2],
      [-2.4, -0.5],
      [Math.PI, 0.1],
    ] as const) {
      const cp = Math.cos(pitch);
      expectVec(rotate(yaw, pitch, 0.6, [0, 0, 1]), [
        Math.sin(yaw) * cp,
        Math.sin(pitch),
        Math.cos(yaw) * cp,
      ]);
    }
  });

  it('turns towards +X (the left flank) for positive yaw', () => {
    expectVec(rotate(90 * DEG, 0, 0, [0, 0, 1]), [1, 0, 0]);
  });

  it('raises the nose for positive pitch', () => {
    expect(rotate(0, 20 * DEG, 0, [0, 0, 1])[1]).toBeGreaterThan(0);
  });

  it('lowers the right (−X) flank for positive roll', () => {
    const right = rotate(0, 0, 30 * DEG, [-1, 0, 0]);
    expect(right[1]).toBeLessThan(0);
    const up = rotate(0, 0, 30 * DEG, [0, 1, 0]);
    expect(up[0]).toBeLessThan(0);
  });
});
