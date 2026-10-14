import { describe, expect, it } from 'vitest';
import {
  BELLY_UP,
  bagCentre,
  bagHeight,
  bagPose,
  bagRadius,
  createPose,
  deadAnchor,
  deadPose,
  DYING_S,
  dyingPose,
  floatHeight,
  raySphere,
  type Anchor,
  type Pose,
  type WaterBox,
} from './poses';

/** Sand sloping from 11 cm at the back glass down to 5 cm at the front, like the default scape. */
const ground = (_x: number, z: number): number => 0.08 - 0.125 * z;
const BOX: WaterBox = { minX: -0.59, maxX: 0.59, ground, minZ: -0.24, maxZ: 0.24, top: 0.47 };
const LENGTH = 0.06;
const START: Anchor = { x: 0.2, y: 0.25, z: -0.05, yaw: 0.7 };

function inside(pose: Pose, length = LENGTH): void {
  expect(pose.x).toBeGreaterThanOrEqual(BOX.minX + length / 2 - 1e-9);
  expect(pose.x).toBeLessThanOrEqual(BOX.maxX - length / 2 + 1e-9);
  expect(pose.z).toBeGreaterThanOrEqual(BOX.minZ + length / 2 - 1e-9);
  expect(pose.z).toBeLessThanOrEqual(BOX.maxZ - length / 2 + 1e-9);
  expect(pose.y).toBeLessThanOrEqual(BOX.top);
  expect(pose.y).toBeGreaterThanOrEqual(ground(pose.x, pose.z) - 1e-9);
}

describe('dyingPose', () => {
  it('starts exactly where the fish was, upright and swimming', () => {
    const pose = createPose();
    dyingPose(0, START, LENGTH, 0.3, BOX, pose);
    expect(pose).toMatchObject({ x: START.x, y: START.y, z: START.z, yaw: START.yaw });
    expect(pose.roll).toBeCloseTo(0, 9);
    expect(pose.pitch).toBeCloseTo(0, 9);
    expect(pose.liveliness).toBe(1);
  });

  it('ends limp and belly-up at the surface, then floats on without a jump', () => {
    const end = createPose();
    const after = createPose();
    dyingPose(DYING_S - 1e-6, START, LENGTH, 0.3, BOX, end);
    dyingPose(DYING_S + 1e-6, START, LENGTH, 0.3, BOX, after);
    expect(end.roll).toBeCloseTo(BELLY_UP, 4);
    expect(end.y).toBeCloseTo(floatHeight(BOX, LENGTH), 4);
    expect(end.liveliness).toBeCloseTo(0, 6);
    for (const key of ['x', 'y', 'z', 'yaw', 'pitch', 'roll'] as const) {
      expect(after[key], key).toBeCloseTo(end[key], 4);
    }
    expect(after.liveliness).toBe(0);
  });

  it('thrashes in between and never leaves the water', () => {
    const pose = createPose();
    let maxRoll = 0;
    let moved = 0;
    for (let t = 0; t <= DYING_S + 30; t += 0.05) {
      dyingPose(t, START, LENGTH, 0.81, BOX, pose);
      inside(pose);
      if (t < DYING_S) maxRoll = Math.max(maxRoll, Math.abs(pose.roll));
      moved = Math.max(moved, Math.hypot(pose.x - START.x, pose.z - START.z));
    }
    expect(moved).toBeGreaterThan(LENGTH / 2);
    expect(maxRoll).toBeGreaterThan(1);
  });

  it('does not lift a fish that dies just above low sand', () => {
    const length = 0.05;
    const z = 0.13;
    const low: Anchor = { x: 0, y: ground(0, z) + 0.012, z, yaw: 0 };
    const pose = createPose();
    let prev = low.y;
    for (let t = 0; t <= 1; t += 1 / 60) {
      dyingPose(t, low, length, 0.37, BOX, pose);
      expect(pose.y - ground(pose.x, pose.z), `t = ${t.toFixed(3)}`).toBeGreaterThanOrEqual(
        0.012 - 1e-9,
      );
      expect(Math.abs(pose.y - prev), `t = ${t.toFixed(3)}`).toBeLessThan(0.01);
      prev = pose.y;
    }
    dyingPose(0, low, length, 0.37, BOX, pose);
    expect(pose.y).toBe(low.y);
    expect(ground(0, z)).toBeLessThan(ground(0, BOX.minZ) - 0.04);
  });

  it('stays in the tank when the fish dies against the glass', () => {
    const pose = createPose();
    const corner: Anchor = {
      x: BOX.maxX - 0.01,
      y: ground(0, BOX.minZ) + 0.01,
      z: BOX.minZ + 0.01,
      yaw: 0,
    };
    for (let t = 0; t <= DYING_S + 5; t += 0.1) {
      dyingPose(t, corner, LENGTH, 0.5, BOX, pose);
      inside(pose);
    }
  });
});

describe('deadPose', () => {
  it('floats belly-up at the surface, still', () => {
    const anchor = deadAnchor(BOX, LENGTH, 0.42);
    const pose = createPose();
    for (let t = 0; t < 120; t += 0.5) {
      deadPose(t, anchor, LENGTH, 0.42, BOX, pose);
      inside(pose);
      expect(Math.abs(pose.roll - BELLY_UP)).toBeLessThan(0.2);
      expect(Math.abs(pose.y - floatHeight(BOX, LENGTH))).toBeLessThan(0.003);
      expect(pose.liveliness).toBe(0);
      expect(pose.speed).toBe(0);
    }
  });

  it('spreads fish that were already dead across the surface', () => {
    const a = deadAnchor(BOX, LENGTH, 0.1);
    const b = deadAnchor(BOX, LENGTH, 0.6);
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(LENGTH);
    for (const seed of [0, 0.25, 0.5, 0.999]) {
      const anchor = deadAnchor(BOX, LENGTH, seed);
      expect(anchor.x).toBeGreaterThanOrEqual(BOX.minX + LENGTH);
      expect(anchor.x).toBeLessThanOrEqual(BOX.maxX - LENGTH);
      expect(anchor.z).toBeGreaterThanOrEqual(BOX.minZ + LENGTH);
      expect(anchor.z).toBeLessThanOrEqual(BOX.maxZ - LENGTH);
    }
  });
});

describe('bagPose', () => {
  it('keeps the fish swimming inside its bag at the surface', () => {
    const pose = createPose();
    const r = bagRadius(LENGTH);
    for (let t = 0; t < 60; t += 0.25) {
      bagPose(t, 1, LENGTH, 0.2, BOX, pose);
      const c = bagCentre(1, BOX);
      expect(Math.hypot(pose.x - c.x, pose.z - c.z)).toBeLessThan(r / 2);
      expect(pose.y).toBeCloseTo(bagHeight(t, LENGTH, 0.2, BOX), 9);
      expect(pose.y).toBeLessThan(BOX.top);
      expect(pose.y + 1.46 * r).toBeGreaterThan(BOX.top);
      expect(pose.liveliness).toBe(1);
      expect(pose.roll).toBe(0);
    }
  });

  it('puts each bag in its own place inside the tank', () => {
    const a = bagCentre(0, BOX);
    const b = bagCentre(1, BOX);
    expect(b.x - a.x).toBeGreaterThan(2 * bagRadius(0.1));
    const far = bagCentre(50, BOX);
    expect(far.x).toBeLessThanOrEqual(BOX.maxX);
  });

  it('sizes the bag to the fish within limits', () => {
    expect(bagRadius(0.01)).toBe(0.035);
    expect(bagRadius(0.08)).toBeCloseTo(0.06, 9);
    expect(bagRadius(0.5)).toBe(0.1);
  });
});

describe('raySphere', () => {
  const origin = { x: 0, y: 0, z: 0 };
  const dir = { x: 0, y: 0, z: 1 };

  it('returns the distance to the near surface', () => {
    expect(raySphere(origin, dir, { x: 0, y: 0, z: 2 }, 0.5)).toBeCloseTo(1.5, 9);
    expect(raySphere(origin, dir, { x: 0.3, y: 0, z: 2 }, 0.5)).toBeCloseTo(1.6, 9);
  });

  it('misses a sphere off the ray or behind it', () => {
    expect(raySphere(origin, dir, { x: 0.6, y: 0, z: 2 }, 0.5)).toBeNull();
    expect(raySphere(origin, dir, { x: 0, y: 0, z: -2 }, 0.5)).toBeNull();
  });

  it('is 0 from inside', () => {
    expect(raySphere(origin, dir, { x: 0, y: 0.1, z: 0 }, 0.5)).toBe(0);
  });
});
