import { describe, expect, it } from 'vitest';
import { DEFAULT_TANK } from '../tank/dimensions';
import { clampEye, moveEye, nearPlaneReach, photoBounds } from './bounds';

const LENS = { near: 0.05, fov: 40, aspect: 16 / 9 };
const bounds = photoBounds(DEFAULT_TANK, LENS);
const { solid, room } = bounds;
const FRONT = { x: 0, y: 0.35, z: 1.6 };

describe('nearPlaneReach', () => {
  it('is the distance from the eye to a corner of the near plane', () => {
    expect(nearPlaneReach({ near: 0.05, fov: 75, aspect: 16 / 9 })).toBeCloseTo(0.0929, 4);
    expect(nearPlaneReach({ near: 0.05, fov: 75, aspect: 19.5 / 9 })).toBeCloseTo(0.1043, 4);
  });

  it('is the near distance itself for a vanishing field of view', () => {
    expect(nearPlaneReach({ near: 0.05, fov: 1e-9, aspect: 2 })).toBeCloseTo(0.05, 12);
  });

  it('refuses a lens that cannot be', () => {
    expect(() => nearPlaneReach({ near: 0, fov: 40, aspect: 1 })).toThrow(RangeError);
    expect(() => nearPlaneReach({ near: 0.05, fov: 180, aspect: 1 })).toThrow(RangeError);
    expect(() => nearPlaneReach({ near: 0.05, fov: 40, aspect: Number.NaN })).toThrow(RangeError);
  });
});

describe('photoBounds', () => {
  it('puts the tank inside the room', () => {
    for (const axis of ['x', 'z'] as const) {
      expect(room.min[axis]).toBeLessThan(solid.min[axis]);
      expect(solid.max[axis]).toBeLessThan(room.max[axis]);
    }
    expect(solid.max.y).toBeGreaterThan(DEFAULT_TANK.height);
    expect(room.min.y).toBeLessThan(0);
  });

  it.each([
    [75, 16 / 9],
    [75, 19.5 / 9],
    [75, 32 / 9],
    [15, 9 / 19.5],
  ])('keeps every near-plane corner off the glass and lid at %d° and aspect %f', (fov, aspect) => {
    const lens = { near: 0.05, fov, aspect };
    const reach = nearPlaneReach(lens);
    const wide = photoBounds(DEFAULT_TANK, lens);
    expect(wide.solid.max.z - DEFAULT_TANK.depth / 2).toBeGreaterThan(reach);
    expect(-DEFAULT_TANK.depth / 2 - wide.solid.min.z).toBeGreaterThan(reach);
    expect(wide.solid.max.x - DEFAULT_TANK.length / 2).toBeGreaterThan(reach);
    expect(wide.solid.max.y - DEFAULT_TANK.height).toBeGreaterThan(reach);
  });

  it('gives a wider view more room', () => {
    const wide = photoBounds(DEFAULT_TANK, { ...LENS, fov: 75 });
    expect(wide.solid.max.z).toBeGreaterThan(solid.max.z);
  });
});

describe('clampEye', () => {
  it('leaves an eye clear of the tank where it is', () => {
    expect(clampEye(FRONT, bounds)).toEqual(FRONT);
  });

  it('keeps the eye inside the room', () => {
    const eye = clampEye({ x: 40, y: -5, z: 2 }, bounds);
    expect(eye).toEqual({ x: room.max.x, y: room.min.y, z: 2 });
  });

  it('pushes an eye out of the tank through the nearest face', () => {
    const nearFront = clampEye({ x: 0.1, y: 0.25, z: solid.max.z - 0.01 }, bounds);
    expect(nearFront).toEqual({ x: 0.1, y: 0.25, z: solid.max.z });
    const nearTop = clampEye({ x: 0.1, y: solid.max.y - 0.01, z: 0 }, bounds);
    expect(nearTop).toEqual({ x: 0.1, y: solid.max.y, z: 0 });
    const nearLeft = clampEye({ x: solid.min.x + 0.01, y: -0.3, z: 0 }, bounds);
    expect(nearLeft).toEqual({ x: solid.min.x, y: -0.3, z: 0 });
  });

  it('takes an eye in the water out through the nearest glass', () => {
    const eye = clampEye({ x: 0, y: 0.25, z: DEFAULT_TANK.depth / 2 - 0.05 }, bounds);
    expect(eye).toEqual({ x: 0, y: 0.25, z: solid.max.z });
  });

  it('refuses a position that is not a number', () => {
    expect(() => clampEye({ x: Number.NaN, y: 0, z: 0 }, bounds)).toThrow(RangeError);
  });
});

describe('moveEye', () => {
  it('moves freely through the room', () => {
    const to = { x: 0.5, y: 0.6, z: 1.2 };
    expect(moveEye(FRONT, to, bounds)).toEqual(to);
  });

  it('stops a long step at the front glass instead of tunnelling out the back', () => {
    const eye = moveEye(FRONT, { x: 0, y: 0.35, z: -1.6 }, bounds);
    expect(eye).toEqual({ x: 0, y: 0.35, z: solid.max.z });
  });

  it('holds an eye resting on the glass there, and lets it move along it', () => {
    const resting = { x: 0, y: 0.3, z: solid.max.z };
    expect(moveEye(resting, { x: 0, y: 0.3, z: -1 }, bounds)).toEqual(resting);
    expect(moveEye(resting, { x: 0.2, y: 0.32, z: solid.max.z }, bounds)).toEqual({
      x: 0.2,
      y: 0.32,
      z: solid.max.z,
    });
  });

  it('passes beside the tank without touching it', () => {
    const from = { x: solid.max.x + 0.3, y: 0.3, z: 1 };
    const to = { x: solid.max.x + 0.3, y: 0.3, z: -1 };
    expect(moveEye(from, to, bounds)).toEqual(to);
  });

  it('slides along the glass a step meets at an angle', () => {
    const eye = moveEye(FRONT, { x: 0.3, y: 0.3, z: 0 }, bounds);
    expect(eye).toEqual({ x: 0.3, y: 0.3, z: solid.max.z });
  });

  it('lands on the lid from above', () => {
    const eye = moveEye({ x: 0, y: 1.2, z: 0 }, { x: 0.1, y: 0.2, z: 0 }, bounds);
    expect(eye).toEqual({ x: 0.1, y: solid.max.y, z: 0 });
  });

  it('slides along a side the step enters last', () => {
    const from = { x: solid.max.x + 0.5, y: 0.3, z: solid.max.z + 0.1 };
    const eye = moveEye(from, { x: solid.max.x - 0.2, y: 0.3, z: solid.max.z - 0.3 }, bounds);
    expect(eye.x).toBe(solid.max.x);
    expect(eye.z).toBeCloseTo(solid.max.z - 0.3, 10);
  });

  it('refuses a target that is not a number', () => {
    expect(() => moveEye(FRONT, { x: 0, y: Number.POSITIVE_INFINITY, z: 0 }, bounds)).toThrow(
      RangeError,
    );
  });
});
